/* ============================================================
   Capiq V0.1 — Contrôleur principal de l'application
   Lie l'interface (cadran, curseurs, réglages) au BLEService,
   au stockage local et au service worker.
   ============================================================ */

import { BLEService } from './ble_service.js';
import * as storage from './storage_service.js';
import { wrap180, normalize360, NavigationService, calculateDistance, calculateBearing } from './navigation_service.js';
import { Waypoint } from '../models/navigation_model.js';

const APP_VERSION = '0.1.0';

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
  heading: null,
  error: null,
  battery: null,
  deviceStatus: null,
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
  if (!fromDevice) storage.saveTarget(state.target);
  updateSendButton();
  updateDirectionBanner();
}

function updateSendButton() {
  $('send-target').disabled = !state.connected || state.target === null;
}

async function sendTarget() {
  if (state.target === null) return;
  try {
    await ble.sendTargetAzimuth(state.target);
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

  // Le casque est la référence une fois connecté (cible modifiable
  // aussi par console série) : on recale l'UI si elle diverge.
  if (pkt.target !== null && pkt.target !== undefined &&
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

  const cal = $('cal-status');
  if (st.imu === false) {
    cal.textContent = '⚠️ IMU non détectée par le casque : vérifier le câblage.';
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

async function toggleConnection() {
  if (state.connected) {
    ble.disconnect();
    return;
  }
  const pill = $('connection-pill');
  pill.dataset.state = 'wait';
  pill.textContent = 'Connexion…';
  try {
    await ble.connect();
  } catch (err) {
    pill.dataset.state = 'off';
    pill.textContent = 'Déconnecté';
    if (err.name !== 'NotFoundError') { // NotFoundError = sélection annulée
      toast(`Connexion impossible : ${err.message}`, 4000);
    }
  }
}

async function onConnected(name) {
  setConnectedUI(true, name);
  toast(`✓ Connecté à ${name}`);
  // L'app est la source de vérité des réglages : push automatique
  try {
    await ble.sendSettings(state.settings);
    if (state.target !== null) await ble.sendTargetAzimuth(state.target);
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
  });
  $('btn-apply-settings').addEventListener('click', async () => {
    try {
      await ble.sendSettings(state.settings);
      toast('✓ Réglages appliqués au casque');
    } catch (err) {
      toast(`Échec : ${err.message}`);
    }
  });
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
    navigator.serviceWorker.register('./service-worker.js').catch((err) => {
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
