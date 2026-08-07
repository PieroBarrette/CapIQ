/* ============================================================
   Capiq V0.1 — Contrôleur principal de l'application
   Lie l'interface (cadran, curseurs, réglages) au BLEService,
   au stockage local et au service worker.
   ============================================================ */

import { BLEService, describeBleError } from './ble_service.js';
import * as storage from './storage_service.js';
import { wrap180, normalize360, NavigationService, calculateDistance, calculateBearing,
         generateCluster, pivotCluster, DEFAULT_CLUSTER_COUNT } from './navigation_service.js';
import { Waypoint } from '../models/navigation_model.js';
import { parseGpx } from './gpx_service.js';
import * as geomag from './geomag_service.js';

// DOIT rester aligné sur CACHE_NAME dans service-worker.js : c'est ce que
// l'onglet Réglages affiche, et donc le seul moyen de savoir quelle version
// tourne réellement sur un téléphone.
const APP_VERSION = '0.1.9';

const MODE_LABELS = {
  BOOT: 'Démarrage',
  CONNECTION: 'En attente',
  DIRECTION: 'Guidage',
  CALIBRATION: 'Calibration',
  ERROR: 'Erreur capteur',
};

const $ = (id) => document.getElementById(id);
const SVG_NS = 'http://www.w3.org/2000/svg';

/* ============================================================
   Cadran boussole interactif (SVG)
   Cadran fixe (N en haut), aiguille = cap de la tête,
   marqueur orange = azimut cible. Toucher/glisser règle la cible.
   ============================================================ */
class CompassDial {
  constructor(svg, { onTargetInput }) {
    this.svg = svg;
    this.onTargetInput = onTargetInput;
    this._build();
    this._bindPointer();
  }

  _el(name, attrs, parent = this.svg) {
    const node = document.createElementNS(SVG_NS, name);
    for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
    parent.appendChild(node);
    return node;
  }

  _build() {
    // Fond
    this._el('circle', { cx: 100, cy: 100, r: 92, fill: 'var(--panel-2)', stroke: 'var(--border)', 'stroke-width': 2 });

    // Graduations (15°, majeures aux cardinales)
    for (let a = 0; a < 360; a += 15) {
      const major = a % 90 === 0;
      const r1 = major ? 78 : 84;
      const rad = (a * Math.PI) / 180;
      const sin = Math.sin(rad);
      const cos = Math.cos(rad);
      this._el('line', {
        x1: 100 + r1 * sin, y1: 100 - r1 * cos,
        x2: 100 + 89 * sin, y2: 100 - 89 * cos,
        stroke: major ? 'var(--muted)' : 'var(--border)',
        'stroke-width': major ? 2.5 : 1.5,
      });
    }

    // Lettres cardinales (français : N E S O)
    const cards = [['N', 0], ['E', 90], ['S', 180], ['O', 270]];
    for (const [label, a] of cards) {
      const rad = (a * Math.PI) / 180;
      this._el('text', {
        x: 100 + 66 * Math.sin(rad),
        y: 100 - 66 * Math.cos(rad) + 5,
        'text-anchor': 'middle',
        'font-size': 14,
        'font-weight': 700,
        fill: a === 0 ? 'var(--accent)' : 'var(--muted)',
      }).textContent = label;
    }

    // Marqueur de cible (triangle orange sur le pourtour)
    this.targetGroup = this._el('g', { visibility: 'hidden' });
    this._el('polygon', { points: '100,12 91,27 109,27', fill: 'var(--accent)' }, this.targetGroup);

    // Aiguille de cap
    this.needleGroup = this._el('g', { visibility: 'hidden' });
    this._el('polygon', { points: '100,20 92,74 108,74', fill: 'var(--ok)' }, this.needleGroup);
    this.needlePoly = this.needleGroup.firstChild;

    // Disque central + lecture du cap
    this._el('circle', { cx: 100, cy: 100, r: 36, fill: 'var(--panel)', stroke: 'var(--border)', 'stroke-width': 1.5 });
    this.headingText = this._el('text', {
      x: 100, y: 104, 'text-anchor': 'middle', 'font-size': 24,
      'font-weight': 800, fill: 'var(--text)',
    });
    this.headingText.textContent = '--';
    this._el('text', {
      x: 100, y: 121, 'text-anchor': 'middle', 'font-size': 9,
      fill: 'var(--muted)', 'letter-spacing': '0.1em',
    }).textContent = 'CAP';
  }

  _bindPointer() {
    let dragging = false;
    const apply = (e) => {
      const rect = this.svg.getBoundingClientRect();
      const dx = e.clientX - (rect.left + rect.width / 2);
      const dy = e.clientY - (rect.top + rect.height / 2);
      if (dx * dx + dy * dy < 100) return; // ignore le centre mort
      const deg = Math.round((Math.atan2(dx, -dy) * 180) / Math.PI + 360) % 360;
      this.onTargetInput(deg);
    };
    this.svg.addEventListener('pointerdown', (e) => {
      dragging = true;
      this.svg.setPointerCapture(e.pointerId);
      apply(e);
    });
    this.svg.addEventListener('pointermove', (e) => { if (dragging) apply(e); });
    this.svg.addEventListener('pointerup', () => { dragging = false; });
    this.svg.addEventListener('pointercancel', () => { dragging = false; });
  }

  setHeading(deg) {
    if (deg === null || deg === undefined) {
      this.needleGroup.setAttribute('visibility', 'hidden');
      this.headingText.textContent = '--';
      return;
    }
    this.needleGroup.setAttribute('visibility', 'visible');
    this.needleGroup.setAttribute('transform', `rotate(${deg} 100 100)`);
    this.headingText.textContent = `${Math.round(deg)}°`;
  }

  setTarget(deg) {
    if (deg === null || deg === undefined) {
      this.targetGroup.setAttribute('visibility', 'hidden');
      return;
    }
    this.targetGroup.setAttribute('visibility', 'visible');
    this.targetGroup.setAttribute('transform', `rotate(${deg} 100 100)`);
  }

  setAligned(aligned) {
    this.needlePoly.setAttribute('fill', aligned ? 'var(--ok)' : 'var(--text)');
  }
}

/* ============================================================
   État et services
   ============================================================ */
const state = {
  target: storage.loadTarget(),      // number | null
  settings: storage.loadSettings(),
  connected: false,
  targetPending: false,    // true = cible saisie localement, pas encore envoyée
  settingsPending: false,  // true = réglages saisis, pas encore appliqués
  absoluteHeading: true,   // false = cap relatif (gyroscope seul), dérive
  heading: null,
  error: null,
  battery: null,
  deviceStatus: null,

  // ---- Navigation GPS ----
  waypoints: storage.loadWaypoints(),
  selectedWpId: null,
  gpsOn: false,
  navAutoSend: false,
  lastSentBearing: null,
  lastSentAt: 0,
};

const ble = new BLEService();
const nav = new NavigationService(); // V0.2 : guidage GPS

let dial;
let deferredInstallPrompt = null;
let toastTimer = null;

/* ---------- Aides UI ---------- */

function toast(message, ms = 2600) {
  const el = $('toast');
  el.textContent = message;
  el.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.add('hidden'), ms);
}

function fmtDeg(v, decimals = 1) {
  return v === null || v === undefined ? '--' : `${v.toFixed(decimals)}°`;
}

/* ---------- Cible ---------- */

function setTargetLocal(deg, { fromDevice = false } = {}) {
  state.target = Math.round(normalize360(deg) * 10) / 10;
  $('target-number').value = state.target;
  $('target-slider').value = Math.round(state.target) % 360;
  dial.setTarget(state.target);
  $('stat-target').textContent = fmtDeg(state.target, state.target % 1 ? 1 : 0);
  if (!fromDevice) {
    storage.saveTarget(state.target);
    // Saisie de l'utilisateur : on protège la valeur jusqu'à l'envoi.
    state.targetPending = true;
  }
  updateSendButton();
  updateDirectionBanner();
}

function updateSendButton() {
  $('send-target').disabled = !state.connected || state.target === null;
  // Rappel discret mais visible : la cible affichée n'est pas encore active
  // sur le casque tant qu'ENVOYER n'a pas été touché.
  $('target-pending-hint').classList.toggle('hidden', !state.targetPending);
  $('stat-target').classList.toggle('pending', state.targetPending);
}

async function sendTarget() {
  if (state.target === null) return;
  try {
    await ble.sendTargetAzimuth(state.target);
    state.targetPending = false;   // le casque fait de nouveau autorité
    updateSendButton();
    toast(`🎯 Cible envoyée au casque : ${state.target}°`);
  } catch (err) {
    toast(`Échec de l'envoi : ${err.message}`);
  }
}

/* ---------- Rendu télémétrie / connexion ---------- */

function updateDirectionBanner() {
  const banner = $('direction-banner');
  banner.classList.remove('ok', 'turn', 'muted');

  if (!state.connected) {
    banner.classList.add('muted');
    banner.textContent = state.target === null
      ? 'Choisissez un azimut cible puis envoyez-le au casque.'
      : 'Connectez-vous au casque pour démarrer le guidage.';
    return;
  }
  if (state.error === null) {
    banner.classList.add('muted');
    banner.textContent = 'Envoyez un azimut cible pour démarrer le guidage.';
    return;
  }
  if (Math.abs(state.error) <= state.settings.deadzone) {
    banner.classList.add('ok');
    banner.textContent = '✓ ALIGNÉ — gardez le cap';
  } else if (state.error > 0) {
    banner.classList.add('turn');
    banner.textContent = `TOURNEZ À DROITE ⟶  (+${state.error.toFixed(1)}°)`;
  } else {
    banner.classList.add('turn');
    banner.textContent = `⟵ TOURNEZ À GAUCHE  (${state.error.toFixed(1)}°)`;
  }
}

function handleTelemetry(pkt) {
  state.heading = pkt.heading ?? null;
  state.error = pkt.error ?? null;
  if (pkt.battery !== undefined) state.battery = pkt.battery;

  // Le casque reste la référence de la cible (elle est aussi modifiable par
  // la console série), MAIS jamais pendant que l'utilisateur en saisit une
  // nouvelle : sinon la télémétrie (5 Hz) écrase la saisie avant même qu'il
  // ait pu appuyer sur ENVOYER.
  if (!state.targetPending &&
      pkt.target !== null && pkt.target !== undefined &&
      (state.target === null || Math.abs(wrap180(pkt.target - state.target)) > 0.05)) {
    setTargetLocal(pkt.target, { fromDevice: true });
  }

  $('stat-heading').textContent = fmtDeg(state.heading);
  $('stat-error').textContent = state.error === null ? '--'
    : `${state.error > 0 ? '+' : ''}${state.error.toFixed(1)}°`;
  $('battery-meta').textContent = state.battery === null ? '🔋 --' : `🔋 ${state.battery} %`;

  dial.setHeading(state.heading);
  dial.setAligned(state.error !== null && Math.abs(state.error) <= state.settings.deadzone);
  updateDirectionBanner();
}

function handleStatus(st) {
  state.deviceStatus = st;
  $('about-fw').textContent = st.fw || '—';
  $('mode-meta').textContent = `Mode : ${MODE_LABELS[st.mode] || st.mode || '—'}`;

  // absolute === false : cap issu du gyroscope seul, il dérive. Ne jamais
  // laisser croire à un azimut vrai — on l'annonce et on offre le recalage.
  state.absoluteHeading = st.absolute !== false;
  $('relative-heading-notice').classList.toggle('hidden', state.absoluteHeading);
  // Un azimut GPS est un cap ABSOLU : l'envoyer à un casque dont le cap
  // dérive n'a de sens que s'il vient d'être recalé. On le dit franchement.
  $('nav-relative-warning').classList.toggle('hidden', state.absoluteHeading);
  $('btn-align').disabled = !state.connected;

  // Le casque recalcule lui-même son offset quand on inverse le sens de
  // rotation ou qu'on recale le cap : on adopte ses valeurs, sauf si
  // l'utilisateur a une saisie en attente (voir le bug de l'azimut cible).
  if (!state.settingsPending) {
    if (typeof st.offset === 'number' && st.offset !== state.settings.offset) {
      state.settings.offset = st.offset;
      $('set-offset').value = st.offset;
      storage.saveSettings(state.settings);
    }
    if (typeof st.invert === 'boolean' && st.invert !== state.settings.invert) {
      state.settings.invert = st.invert;
      $('set-invert').checked = st.invert;
      storage.saveSettings(state.settings);
    }
  }

  const cal = $('cal-status');
  if (st.imu === false) {
    // imuDiag donne la cause exacte remontée par le casque (balayage I2C).
    cal.textContent = `⚠️ Capteur non fonctionnel — ${st.imuDiag || 'cause inconnue'}. `
                    + 'Branchez le casque en USB et tapez « s » dans le moniteur série '
                    + 'pour le détail du bus I2C.';
  } else if (st.mag === false) {
    cal.textContent = '⚠️ Magnétomètre absent (module clone ?) — le cap dérivera.';
  } else if (st.cal === false) {
    cal.textContent = 'Capteur NON calibré : lancez les deux calibrations ci-dessus.';
  } else {
    cal.textContent = `Capteur calibré ✓ — fréquence IMU mesurée : ${st.rate || '—'} Hz.`;
  }
}

function setConnectedUI(connected, name = '') {
  state.connected = connected;
  const pill = $('connection-pill');
  pill.dataset.state = connected ? 'on' : 'off';
  pill.textContent = connected ? `Connecté · ${name}` : 'Déconnecté';
  $('btn-connect').textContent = connected ? '✂️ Se déconnecter' : '🔗 Se connecter au casque';
  $('btn-apply-settings').disabled = !connected;
  $('btn-cal-imu').disabled = !connected;
  $('btn-cal-mag').disabled = !connected;
  $('btn-align').disabled = !connected;
  if (!connected) {
    state.heading = null;
    state.error = null;
    $('stat-heading').textContent = '--';
    $('stat-error').textContent = '--';
    $('signal-meta').textContent = '📶 —';
    $('mode-meta').textContent = 'Mode : —';
    dial.setHeading(null);
  }
  updateSendButton();
  updateDirectionBanner();
}

/* ---------- Connexion ---------- */

function showConnectError(info, severity = 'err') {
  const box = $('connect-error');
  if (!info) {
    box.classList.add('hidden');
    return;
  }
  box.classList.remove('err', 'warn');
  box.classList.add(severity);
  $('connect-error-title').textContent = info.title;
  $('connect-error-advice').textContent = info.advice;
  box.classList.remove('hidden');
}

async function startConnection({ allDevices = false } = {}) {
  const pill = $('connection-pill');
  pill.dataset.state = 'wait';
  pill.textContent = 'Connexion…';
  $('btn-connect').disabled = true;
  showConnectError(null);

  // Chien de garde : sur Android, requestDevice() peut rester en attente
  // indéfiniment sans jamais afficher le sélecteur (scan BLE bloqué par la
  // Localisation ou la permission « Appareils à proximité »). L'interface
  // restait alors figée sur « Connexion… » sans le moindre message.
  // On ne peut pas annuler requestDevice() : on informe sans interrompre.
  const watchdog = setTimeout(() => {
    showConnectError({
      title: 'Aucune fenêtre de sélection ne s\'est ouverte',
      advice: 'Si vous ne voyez pas la liste des appareils, le scan Bluetooth '
            + 'est bloqué par Android. Activez la Localisation (GPS) du '
            + 'téléphone et autorisez « Appareils à proximité » pour Chrome '
            + '(Paramètres → Applications → Chrome → Autorisations), puis '
            + 'relancez. Réglages → Diagnostic Bluetooth confirme lequel des '
            + 'deux manque.',
    }, 'warn');
    // requestDevice() reste en attente : sans cela le bouton resterait
    // désactivé indéfiniment et l'utilisateur ne pourrait pas réessayer.
    $('btn-connect').disabled = false;
    $('connection-pill').dataset.state = 'off';
    $('connection-pill').textContent = 'Déconnecté';
  }, 15000);

  try {
    await ble.connect({ allDevices });
  } catch (err) {
    pill.dataset.state = 'off';
    pill.textContent = 'Déconnecté';
    // Toute erreur autre qu'une annulation est affichée EN CLAIR et de façon
    // persistante : un toast fugace laissait l'utilisateur sans explication.
    const info = describeBleError(err);
    // Une annulation efface aussi l'avertissement éventuel du chien de garde :
    // si le sélecteur a fini par s'ouvrir, le message n'a plus lieu d'être.
    showConnectError(info.cancelled ? null : info);
    console.warn('[BLE] échec de connexion :', err);
  } finally {
    clearTimeout(watchdog);
    $('btn-connect').disabled = false;
  }
}

async function toggleConnection() {
  if (state.connected) {
    ble.disconnect();
    return;
  }
  await startConnection();
}

async function onConnected(name) {
  setConnectedUI(true, name);
  showConnectError(null);
  toast(`✓ Connecté à ${name}`);
  // L'app est la source de vérité des réglages : push automatique
  try {
    await ble.sendSettings(state.settings);
    // L'app pousse sa cible à la connexion : elle et le casque sont alors
    // d'accord, la télémétrie peut reprendre son rôle de référence.
    if (state.target !== null) await ble.sendTargetAzimuth(state.target);
    state.targetPending = false;
    updateSendButton();
  } catch { /* le casque vient peut-être de couper */ }
}

/* ---------- Réglages ---------- */

function renderSettingsInputs() {
  const s = state.settings;
  $('set-deadzone').value = s.deadzone;
  $('val-deadzone').textContent = `±${s.deadzone}°`;
  $('set-brightness').value = s.brightness;
  $('val-brightness').textContent = `${s.brightness} %`;
  $('set-rate').value = s.rate;
  $('val-rate').textContent = `${s.rate} Hz`;
  $('set-offset').value = s.offset;
  $('set-invert').checked = !!s.invert;
  $('set-declination').value = s.declination || 0;
  $('val-declination').textContent = `${s.declination || 0}°`;
}

function bindSettings() {
  $('set-deadzone').addEventListener('input', (e) => {
    state.settings.deadzone = parseFloat(e.target.value);
    $('val-deadzone').textContent = `±${state.settings.deadzone}°`;
    storage.saveSettings(state.settings);
    updateDirectionBanner();
  });
  $('set-brightness').addEventListener('input', (e) => {
    state.settings.brightness = parseInt(e.target.value, 10);
    $('val-brightness').textContent = `${state.settings.brightness} %`;
    storage.saveSettings(state.settings);
  });
  $('set-rate').addEventListener('input', (e) => {
    state.settings.rate = parseInt(e.target.value, 10);
    $('val-rate').textContent = `${state.settings.rate} Hz`;
    storage.saveSettings(state.settings);
  });
  $('set-offset').addEventListener('change', (e) => {
    const v = parseFloat(e.target.value);
    state.settings.offset = Number.isFinite(v) ? wrap180(v) : 0;
    e.target.value = state.settings.offset;
    storage.saveSettings(state.settings);
    // Même précaution que pour l'azimut cible : tant que l'utilisateur n'a
    // pas appliqué, le statut du casque ne doit pas écraser sa saisie.
    state.settingsPending = true;
  });

  // Interrupteur : effet immédiat, sans passer par « Appliquer ». Le casque
  // conserve le cap affiché et recalcule son offset ; on le relira au statut.
  $('set-invert').addEventListener('change', async (e) => {
    state.settings.invert = e.target.checked;
    storage.saveSettings(state.settings);
    if (!state.connected) return;
    try {
      await ble.sendCommand({ cmd: 'set', invert: state.settings.invert });
      toast(state.settings.invert ? '🔄 Sens de rotation inversé' : '🔄 Sens de rotation direct');
    } catch (err) {
      toast(`Échec : ${err.message}`);
    }
  });

  $('btn-apply-settings').addEventListener('click', async () => {
    try {
      await ble.sendSettings(state.settings);
      state.settingsPending = false;
      toast('✓ Réglages appliqués au casque');
    } catch (err) {
      toast(`Échec : ${err.message}`);
    }
  });
}

/* ============================================================
   Navigation GPS
   ============================================================ */

/** Identifiant stable pour retrouver un point dans la liste. */
function newWaypointId() {
  return `wp${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

function saveWaypoints() {
  storage.saveWaypoints(state.waypoints);
}

function selectedWaypoint() {
  return state.waypoints.find((w) => w.id === state.selectedWpId) || null;
}

function fmtDistance(m) {
  if (!Number.isFinite(m)) return '--';
  if (m < 1000) return `${Math.round(m)} m`;
  return `${(m / 1000).toFixed(m < 10000 ? 2 : 1)} km`;
}

function fmtCoord(v) {
  return Number.isFinite(v) ? v.toFixed(5) : '--';
}

/**
 * Déclinaison au point courant : issue du modèle WMM s'il est chargé,
 * sinon de la saisie manuelle. Retourne aussi sa provenance, pour que
 * l'affichage ne laisse jamais croire à un calcul automatique.
 */
function currentDeclination(latitude, longitude) {
  if (geomag.isModelLoaded() && Number.isFinite(latitude)) {
    const d = geomag.magneticDeclination(latitude, longitude);
    if (d !== null) return { value: d, source: 'modèle WMM' };
  }
  return { value: state.settings.declination || 0, source: 'saisie manuelle' };
}

function renderWaypointList() {
  const ul = $('waypoint-list');
  ul.innerHTML = '';
  $('waypoint-empty').classList.toggle('hidden', state.waypoints.length > 0);

  for (const wp of state.waypoints) {
    const li = document.createElement('li');
    li.className = 'wp-item' + (wp.id === state.selectedWpId ? ' selected' : '');

    const main = document.createElement('div');
    main.className = 'wp-main';
    const title = document.createElement('div');
    title.className = 'wp-title';
    title.textContent = wp.name || 'Point sans nom';
    const coords = document.createElement('div');
    coords.className = 'wp-coords';
    coords.textContent = `${fmtCoord(wp.latitude)}, ${fmtCoord(wp.longitude)}`;
    // Distance affichée dès qu'une position GPS est connue
    const here = nav.lastPosition;
    if (here) coords.textContent += ` · ${fmtDistance(calculateDistance(here, wp))}`;
    main.append(title, coords);
    main.addEventListener('click', () => selectWaypoint(wp.id));

    const del = document.createElement('button');
    del.className = 'wp-del';
    del.textContent = '🗑';
    del.setAttribute('aria-label', `Supprimer ${wp.name || 'ce point'}`);
    del.addEventListener('click', (e) => {
      e.stopPropagation();
      if (!window.confirm(`Supprimer « ${wp.name || 'ce point'} » ?`)) return;
      state.waypoints = state.waypoints.filter((w) => w.id !== wp.id);
      if (state.selectedWpId === wp.id) selectWaypoint(null);
      saveWaypoints();
      renderWaypointList();
    });

    li.append(main, del);
    ul.appendChild(li);
  }
}

function selectWaypoint(id) {
  state.selectedWpId = id;
  const wp = selectedWaypoint();
  nav.setDestination(wp);
  $('nav-active').classList.toggle('hidden', !wp);
  $('nav-target-name').textContent = wp ? (wp.name || 'Point sans nom') : '—';
  if (!wp) {
    state.navAutoSend = false;
    $('nav-auto').checked = false;
  } else if (!state.gpsOn) {
    toast('Activez le GPS pour démarrer le guidage');
  }
  $('btn-cluster-from-wp').disabled = !wp;
  renderClusterPanel();
  renderWaypointList();
}

function addWaypoint(latitude, longitude, name, altitude = null) {
  let wp;
  try {
    wp = new Waypoint({ latitude, longitude, altitude, name });
  } catch (err) {
    toast(err.message);
    return null;
  }
  const entry = { id: newWaypointId(), ...wp.toJSON() };
  state.waypoints.push(entry);
  saveWaypoints();
  renderWaypointList();
  return entry;
}

function handleNavUpdate({ distanceM, bearingDeg, position }) {
  $('nav-distance').textContent = fmtDistance(distanceM);
  $('nav-bearing-true').textContent = `${Math.round(bearingDeg)}°`;

  const decl = currentDeclination(position.latitude, position.longitude);
  const magnetic = normalize360(bearingDeg - decl.value);
  $('nav-bearing-mag').textContent = `${Math.round(magnetic)}°`;
  $('wmm-status').textContent =
    `Déclinaison à votre position : ${decl.value.toFixed(1)}° (${decl.source}).`;

  maybeSendBearing(magnetic);
}

/**
 * Envoie le cap au casque, mais avec parcimonie : une écriture BLE par
 * changement significatif, ou au plus une par seconde. Sans ce filtre, un
 * GPS à 1 Hz saturerait la file d'attente GATT pour rien.
 */
async function maybeSendBearing(magneticBearing) {
  if (!state.navAutoSend || !state.connected) return;
  const now = Date.now();
  const changed = state.lastSentBearing === null
    || Math.abs(wrap180(magneticBearing - state.lastSentBearing)) >= 1;
  if (!changed || now - state.lastSentAt < 1000) return;

  state.lastSentBearing = magneticBearing;
  state.lastSentAt = now;
  try {
    await ble.sendTargetAzimuth(magneticBearing);
    setTargetLocal(magneticBearing, { fromDevice: true });  // pas une saisie utilisateur
  } catch { /* déconnexion en cours : la prochaine position réessaiera */ }
}

function setGpsActive(on) {
  state.gpsOn = on;
  $('btn-gps-toggle').textContent = on ? '⏹ Arrêter le GPS' : '📍 Activer le GPS';
  $('btn-wp-here').disabled = !on;
  $('btn-cluster-here').disabled = !on;
  if (on) {
    try {
      nav.startTracking();
      $('gps-status').textContent = 'Acquisition de la position…';
    } catch (err) {
      state.gpsOn = false;
      $('gps-status').textContent = err.message;
      $('btn-gps-toggle').textContent = '📍 Activer le GPS';
    }
  } else {
    nav.stop();
    state.selectedWpId = null;
    $('nav-active').classList.add('hidden');
    $('gps-lat').textContent = '--';
    $('gps-lon').textContent = '--';
    $('gps-acc').textContent = '--';
    $('gps-status').textContent = 'GPS inactif.';
    renderWaypointList();
  }
}

async function importGpxFile(file) {
  const status = $('import-status');
  status.textContent = 'Lecture du fichier…';
  try {
    const result = parseGpx(await file.text());
    let added = 0;
    for (const wp of result.waypoints) {
      state.waypoints.push({ id: newWaypointId(), ...wp.toJSON() });
      added++;
    }
    saveWaypoints();
    renderWaypointList();
    const notes = result.warnings.length ? ` ${result.warnings.join(' ')}` : '';
    status.textContent = `${added} point(s) importé(s) depuis ${file.name}.${notes}`;
    toast(`📂 ${added} point(s) importé(s)`);
  } catch (err) {
    status.textContent = `Échec : ${err.message}`;
  }
}

async function initGeomagModel() {
  const el = $('wmm-status');
  try {
    const info = await geomag.loadDefaultModel();
    $('manual-decl-row').classList.add('hidden');
    el.textContent = `Modèle ${info.name} chargé (époque ${info.epoch}, `
                   + `valide jusqu'à ${info.validUntil}). La déclinaison est `
                   + 'calculée automatiquement depuis votre position.';
  } catch {
    // Sans coefficients officiels on ne devine pas : on bascule en manuel
    // plutôt que d'appliquer une valeur inventée.
    $('manual-decl-row').classList.remove('hidden');
    el.textContent = 'Modèle magnétique absent (data/WMM.COF). La déclinaison '
                   + 'doit être saisie à la main ci-dessous.';
  }
}

/* ---------- Grappes de micro-placettes ---------- */

function clusterOf(wp) {
  return wp && wp.cluster ? wp.cluster : null;
}

/** Toutes les placettes d'une grappe, dans l'ordre. */
function clusterMembers(clusterId) {
  return state.waypoints
    .filter((w) => w.cluster && w.cluster.id === clusterId)
    .sort((a, b) => a.cluster.index - b.cluster.index);
}

function createCluster(start, azimuth, spacing, count, label) {
  let points;
  try {
    points = generateCluster(start, azimuth, spacing, count);
  } catch (err) {
    toast(err.message);
    return null;
  }
  const clusterId = newWaypointId();
  const name = label || `Grappe ${new Date().toLocaleTimeString('fr-CA', { hour: '2-digit', minute: '2-digit' })}`;

  points.forEach((p, i) => {
    state.waypoints.push({
      id: newWaypointId(),
      latitude: p.latitude,
      longitude: p.longitude,
      altitude: null,
      name: `${name} — P${i + 1}`,
      cluster: { id: clusterId, index: i, azimuth, spacing, count: points.length, name },
    });
  });
  saveWaypoints();
  renderWaypointList();

  const first = clusterMembers(clusterId)[0];
  selectWaypoint(first.id);
  toast(`🌲 ${points.length} placettes créées, azimut ${Math.round(azimuth)}°`);
  return clusterId;
}

/**
 * Virage à 90° sur obstacle. Les placettes déjà relevées (jusqu'à celle
 * sélectionnée incluse) sont conservées telles quelles : les déplacer
 * fausserait un inventaire déjà fait sur le terrain.
 */
function pivotCurrentCluster(side) {
  const wp = selectedWaypoint();
  const meta = clusterOf(wp);
  if (!meta) return;

  const members = clusterMembers(meta.id);
  const points = members.map((m) => ({ latitude: m.latitude, longitude: m.longitude }));
  let result;
  try {
    result = pivotCluster(points, meta.index, meta.azimuth, meta.spacing, side);
  } catch (err) {
    toast(err.message);
    return;
  }

  members.forEach((m, i) => {
    m.latitude = result.points[i].latitude;
    m.longitude = result.points[i].longitude;
    // Seules les placettes replacées suivent le nouvel azimut.
    if (i > meta.index) m.cluster.azimuth = result.azimuth;
  });
  saveWaypoints();
  renderWaypointList();
  renderClusterPanel();
  nav.setDestination(selectedWaypoint());
  toast(`↷ Virage à ${side} : nouvel azimut ${Math.round(result.azimuth)}°`);
}

function renderClusterPanel() {
  const wp = selectedWaypoint();
  const meta = clusterOf(wp);
  $('cluster-panel').classList.toggle('hidden', !meta);
  if (!meta) return;

  $('cluster-cur-name').textContent = meta.name;

  // Azimut du TRONÇON À PARCOURIR, mesuré vers la placette suivante — et
  // non celui de la placette courante. Après un virage, la différence est
  // exactement ce que le technicien doit suivre.
  const next = clusterMembers(meta.id).find((m) => m.cluster.index === meta.index + 1);
  const decl = currentDeclination(wp.latitude, wp.longitude);
  let route = `Placette ${meta.index + 1} sur ${meta.count} · espacement ${meta.spacing} m`;
  if (next) {
    const legTrue = calculateBearing(wp, next);
    const legMag = normalize360(legTrue - decl.value);
    route += ` · vers la suivante : ${Math.round(legTrue)}° vrai `
           + `(${Math.round(legMag)}° à la boussole)`;
  } else {
    route += ' · dernière placette';
  }
  $('cluster-progress').textContent = route;
  $('btn-cluster-next').disabled = meta.index >= meta.count - 1;
  $('btn-cluster-next').textContent = meta.index >= meta.count - 1
    ? 'Grappe terminée ✓' : `Placette ${meta.index + 2} →`;
}

function selectNextPlot() {
  const meta = clusterOf(selectedWaypoint());
  if (!meta) return;
  const next = clusterMembers(meta.id).find((m) => m.cluster.index === meta.index + 1);
  if (next) selectWaypoint(next.id);
}

function bindClusters() {
  const readClusterForm = () => ({
    azimuth: normalize360(parseFloat($('cluster-azimuth').value) || 0),
    spacing: parseFloat($('cluster-spacing').value),
    count: parseInt($('cluster-count').value, 10) || DEFAULT_CLUSTER_COUNT,
  });

  const refreshPreview = () => {
    const { azimuth } = readClusterForm();
    const here = nav.lastPosition;
    const decl = currentDeclination(here && here.latitude, here && here.longitude);
    $('cluster-preview').innerHTML =
      `Azimut <strong>vrai</strong> ${Math.round(azimuth)}° — à la boussole, `
      + `suivez <strong>${Math.round(normalize360(azimuth - decl.value))}°</strong> `
      + `(déclinaison ${decl.value.toFixed(1)}°, ${decl.source}).`;
  };
  $('cluster-azimuth').addEventListener('input', refreshPreview);
  refreshPreview();

  $('btn-cluster-here').addEventListener('click', () => {
    const here = nav.lastPosition;
    if (!here) { toast('Position GPS pas encore disponible'); return; }
    const { azimuth, spacing, count } = readClusterForm();
    createCluster(here, azimuth, spacing, count);
  });

  $('btn-cluster-from-wp').addEventListener('click', () => {
    const wp = selectedWaypoint();
    if (!wp) { toast('Sélectionnez d\'abord un point'); return; }
    const { azimuth, spacing, count } = readClusterForm();
    createCluster(wp, azimuth, spacing, count, `Grappe ${wp.name}`);
  });

  $('btn-cluster-next').addEventListener('click', selectNextPlot);
  $('btn-cluster-left').addEventListener('click', () => pivotCurrentCluster('gauche'));
  $('btn-cluster-right').addEventListener('click', () => pivotCurrentCluster('droite'));
}

function bindNavigation() {
  $('btn-gps-toggle').addEventListener('click', () => setGpsActive(!state.gpsOn));

  $('btn-wp-here').addEventListener('click', () => {
    const here = nav.lastPosition;
    if (!here) { toast('Position GPS pas encore disponible'); return; }
    const name = ($('wp-name').value || '').trim()
      || `Position ${new Date().toLocaleTimeString('fr-CA', { hour: '2-digit', minute: '2-digit' })}`;
    const wp = addWaypoint(here.latitude, here.longitude, name, here.altitude);
    if (wp) { $('wp-name').value = ''; toast(`📌 ${wp.name} enregistré`); }
  });

  $('btn-wp-add').addEventListener('click', () => {
    const lat = parseFloat($('wp-lat').value);
    const lon = parseFloat($('wp-lon').value);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
      toast('Latitude et longitude requises');
      return;
    }
    const name = ($('wp-name').value || '').trim() || `Point ${state.waypoints.length + 1}`;
    if (addWaypoint(lat, lon, name)) {
      $('wp-lat').value = ''; $('wp-lon').value = ''; $('wp-name').value = '';
    }
  });

  $('wp-import').addEventListener('change', (e) => {
    const file = e.target.files && e.target.files[0];
    if (file) importGpxFile(file);
    e.target.value = '';   // permet de réimporter le même fichier
  });

  $('nav-auto').addEventListener('change', (e) => {
    state.navAutoSend = e.target.checked;
    state.lastSentBearing = null;   // force un envoi immédiat
    if (state.navAutoSend && !state.connected) {
      toast('Connectez le casque pour lui envoyer le cap');
    }
  });

  $('btn-nav-stop').addEventListener('click', () => selectWaypoint(null));

  $('set-declination').addEventListener('change', (e) => {
    const v = parseFloat(e.target.value);
    state.settings.declination = Number.isFinite(v) ? v : 0;
    e.target.value = state.settings.declination;
    $('val-declination').textContent = `${state.settings.declination}°`;
    storage.saveSettings(state.settings);
  });

  nav.addEventListener('position', (e) => {
    const p = e.detail;
    $('gps-lat').textContent = fmtCoord(p.latitude);
    $('gps-lon').textContent = fmtCoord(p.longitude);
    $('gps-acc').textContent = Number.isFinite(p.accuracy) ? `±${Math.round(p.accuracy)} m` : '--';
    $('gps-status').textContent = Number.isFinite(p.accuracy) && p.accuracy > 20
      ? 'Position peu précise — sous couvert dense, attendez quelques instants.'
      : 'Position acquise.';
    renderWaypointList();   // met à jour les distances
  });

  nav.addEventListener('navupdate', (e) => handleNavUpdate(e.detail));

  nav.addEventListener('navpaused', (e) => {
    const err = e.detail.error;
    const messages = {
      1: 'Permission de localisation refusée. Autorisez-la pour Chrome.',
      2: 'Position indisponible (pas de signal GPS).',
      3: 'Délai dépassé — signal GPS trop faible.',
    };
    $('gps-status').textContent = messages[err && err.code] || 'Erreur GPS.';
  });
}

/* ---------- Diagnostic Bluetooth ---------- */

/**
 * Rapport d'environnement lisible sur le téléphone lui-même.
 * Cible les causes propres à Android, invisibles depuis un PC :
 * adaptateur indisponible, permission « Appareils à proximité » refusée,
 * Localisation désactivée, contexte non sécurisé.
 */
async function runBluetoothDiagnostics() {
  const out = $('diag-output');
  out.classList.remove('hidden');
  out.textContent = 'Analyse en cours…';

  const lines = [];
  const mark = (ok, label, detail) =>
    lines.push(`${ok ? '✅' : '❌'} ${label}${detail ? ' — ' + detail : ''}`);

  mark(window.isSecureContext, 'Contexte sécurisé (HTTPS)',
       window.location.origin);
  mark(!!navigator.bluetooth, 'API Web Bluetooth présente');

  if (navigator.bluetooth) {
    // getAvailability() = false → pas d'adaptateur OU permission refusée.
    // C'est le signal le plus utile côté Android.
    let available = null;
    try {
      available = await navigator.bluetooth.getAvailability();
    } catch (err) {
      available = `erreur : ${err.message}`;
    }
    mark(available === true, 'Adaptateur Bluetooth disponible', String(available));

    // État de la permission, quand le navigateur l'expose.
    if (navigator.permissions && navigator.permissions.query) {
      try {
        const st = await navigator.permissions.query({ name: 'bluetooth' });
        mark(st.state !== 'denied', 'Permission Bluetooth', st.state);
      } catch {
        lines.push('•  Permission Bluetooth — non interrogeable (normal sur Chrome)');
      }
    }

    // Appareils déjà autorisés pour cette origine (Chrome Android surtout).
    if (navigator.bluetooth.getDevices) {
      try {
        const devices = await navigator.bluetooth.getDevices();
        lines.push(`•  Appareils déjà autorisés : ${devices.length
          ? devices.map((d) => d.name || '(sans nom)').join(', ') : 'aucun'}`);
      } catch { /* non supporté */ }
    }
  }

  const standalone = window.matchMedia('(display-mode: standalone)').matches;
  lines.push(`•  Mode d'affichage : ${standalone ? 'application installée' : 'onglet navigateur'}`);
  lines.push(`•  Connexion réseau : ${navigator.onLine ? 'en ligne' : 'hors ligne'}`);
  lines.push(`•  Version app : ${APP_VERSION}`);
  lines.push(`•  Navigateur : ${navigator.userAgent}`);

  const android = /Android/i.test(navigator.userAgent);
  if (android) {
    lines.push('');
    lines.push('Si tout est ✅ mais que la liste du sélecteur reste vide :');
    lines.push('  1. activer la Localisation (GPS) du téléphone — Android');
    lines.push('     l\'exige pour le scan BLE de Chrome ;');
    lines.push('  2. Paramètres → Applications → Chrome → Autorisations →');
    lines.push('     activer « Appareils à proximité » ;');
    lines.push('  3. oublier Capiq dans les réglages Bluetooth.');
  }

  out.textContent = lines.join('\n');
}

/* ---------- Calibration ---------- */

function bindCalibration() {
  const startCal = async (btn, cmd, seconds, message) => {
    if (!window.confirm(message)) return;
    try {
      await ble.sendCommand({ cmd });
    } catch (err) {
      toast(`Échec : ${err.message}`);
      return;
    }
    const original = btn.textContent;
    btn.disabled = true;
    let left = seconds;
    const timer = setInterval(() => {
      left -= 1;
      btn.textContent = `⏳ Calibration en cours… ${left} s`;
      if (left <= 0) {
        clearInterval(timer);
        btn.textContent = original;
        btn.disabled = !state.connected;
        toast('Calibration terminée (voir l\'état ci-dessous)');
      }
    }, 1000);
    btn.textContent = `⏳ Calibration en cours… ${left} s`;
  };

  $('btn-cal-imu').addEventListener('click', (e) => startCal(
    e.currentTarget, 'cal_imu', 8,
    'Calibration gyroscope/accéléromètre :\n\nPosez le casque À PLAT et NE LE BOUGEZ PLUS pendant 5 secondes.\n\nDémarrer ?'
  ));
  $('btn-cal-mag').addEventListener('click', (e) => startCal(
    e.currentTarget, 'cal_mag', 25,
    'Calibration boussole :\n\nÉloignez-vous de tout métal, puis dessinez lentement des "8" dans tous les sens avec le casque pendant ~20 secondes.\n\nDémarrer ?'
  ));
}

/* ---------- Initialisation ---------- */

function bindUI() {
  dial = new CompassDial($('compass-dial'), {
    onTargetInput: (deg) => setTargetLocal(deg),
  });

  $('target-number').addEventListener('change', (e) => {
    const v = parseFloat(e.target.value);
    if (Number.isFinite(v)) setTargetLocal(v);
  });
  $('target-slider').addEventListener('input', (e) => {
    setTargetLocal(parseInt(e.target.value, 10));
  });
  document.querySelectorAll('.chip[data-az]').forEach((chip) => {
    chip.addEventListener('click', () => setTargetLocal(parseFloat(chip.dataset.az)));
  });

  $('send-target').addEventListener('click', sendTarget);
  $('btn-connect').addEventListener('click', toggleConnection);
  $('btn-connect-all').addEventListener('click', () => startConnection({ allDevices: true }));

  $('btn-align').addEventListener('click', async () => {
    const deg = parseFloat($('align-heading').value);
    if (!Number.isFinite(deg)) return;
    try {
      await ble.sendCommand({ cmd: 'align', heading: normalize360(deg) });
      toast(`🧭 Cap recalé sur ${normalize360(deg)}°`);
    } catch (err) {
      toast(`Échec du recalage : ${err.message}`);
    }
  });

  // Onglets
  document.querySelectorAll('.tab').forEach((tab) => {
    tab.addEventListener('click', () => {
      document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t === tab));
      document.querySelectorAll('.view').forEach((v) =>
        v.classList.toggle('active', v.id === `view-${tab.dataset.view}`));
    });
  });

  bindSettings();
  bindCalibration();
  bindNavigation();
  bindClusters();
  $('btn-diag').addEventListener('click', runBluetoothDiagnostics);
}

function bindBLE() {
  ble.addEventListener('connection', (e) => {
    if (e.detail.connected) onConnected(e.detail.name);
    else {
      setConnectedUI(false);
      toast('Casque déconnecté');
    }
  });
  ble.addEventListener('telemetry', (e) => handleTelemetry(e.detail));
  ble.addEventListener('status', (e) => handleStatus(e.detail));
  ble.addEventListener('battery', (e) => {
    state.battery = e.detail.level;
    $('battery-meta').textContent = `🔋 ${state.battery} %`;
  });
}

function bindSystem() {
  // Web Bluetooth disponible ?
  if (!BLEService.isSupported()) {
    $('bt-unsupported').classList.remove('hidden');
    $('btn-connect').disabled = true;
  }

  // Indicateur hors ligne
  const offlineBanner = $('offline-banner');
  const syncOnline = () => offlineBanner.classList.toggle('hidden', navigator.onLine);
  window.addEventListener('online', syncOnline);
  window.addEventListener('offline', syncOnline);
  syncOnline();

  // Qualité de liaison estimée par la fraîcheur des paquets
  setInterval(() => {
    if (!state.connected) return;
    const age = Date.now() - ble.lastPacketAt;
    const label = age < 2000 ? '📶 Bon' : age < 5000 ? '📶 Faible' : '📶 Perdu';
    $('signal-meta').textContent = label;
  }, 1000);

  // Installation PWA
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    deferredInstallPrompt = e;
    $('btn-install').classList.remove('hidden');
  });
  $('btn-install').addEventListener('click', async () => {
    if (!deferredInstallPrompt) return;
    deferredInstallPrompt.prompt();
    await deferredInstallPrompt.userChoice;
    deferredInstallPrompt = null;
    $('btn-install').classList.add('hidden');
  });

  // Service worker (fonctionnement hors ligne)
  if ('serviceWorker' in navigator) {
    // Le cache est servi en priorité (indispensable hors ligne), ce qui peut
    // laisser un téléphone bloqué sur une version périmée pendant des jours.
    // On force donc une vérification à chaque lancement, et on recharge une
    // fois dès qu'une nouvelle version prend la main.
    // `controllerchange` se déclenche AUSSI à la toute première installation :
    // ne recharger que s'il y avait déjà un service worker aux commandes,
    // sinon la première visite se recharge pour rien.
    const hadController = !!navigator.serviceWorker.controller;
    let reloading = false;
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (!hadController || reloading) return;
      reloading = true;
      window.location.reload();
    });

    navigator.serviceWorker.register('./service-worker.js')
      .then((reg) => {
        reg.update().catch(() => { /* hors ligne : on garde le cache */ });
      })
      .catch((err) => {
        console.warn('[SW] enregistrement impossible :', err);
      });
  }
}

function init() {
  $('about-app').textContent = APP_VERSION;
  bindUI();
  bindBLE();
  bindSystem();
  renderSettingsInputs();
  renderWaypointList();
  initGeomagModel();
  if (state.target !== null) setTargetLocal(state.target, { fromDevice: true });
  updateDirectionBanner();
}

document.addEventListener('DOMContentLoaded', init);

/* ---------- Console de débogage terrain ----------
   Dans la console Chrome (chrome://inspect sur téléphone) :
     capiq.demo()      → simule un casque qui tourne (test UI sans matériel)
     capiq.demo(false) → stoppe la simulation
     capiq.state, capiq.ble, capiq.nav → inspection
--------------------------------------------------- */
let demoTimer = null;
window.capiq = {
  state, ble, nav, storage, Waypoint, calculateDistance, calculateBearing,
  demo(on = true) {
    clearInterval(demoTimer);
    demoTimer = null;
    if (!on) { setConnectedUI(false); return; }
    setConnectedUI(true, 'Capiq (démo)');
    if (state.target === null) setTargetLocal(90);
    let h = 310;
    ble.lastPacketAt = Date.now();
    demoTimer = setInterval(() => {
      h = normalize360(h + 1.8);
      ble.lastPacketAt = Date.now();
      handleTelemetry({
        target: state.target,
        heading: Math.round(h * 10) / 10,
        error: Math.round(wrap180(state.target - h) * 10) / 10,
        battery: 87,
      });
    }, 150);
    handleStatus({ fw: '0.1.0 (démo)', mode: 'DIRECTION', imu: true, mag: true, cal: true, rate: 99 });
  },
};
