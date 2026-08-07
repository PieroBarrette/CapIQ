/* ============================================================
   Capiq — Déclinaison magnétique (World Magnetic Model)

   POURQUOI CE MODULE
   Le calcul GPS `calculateBearing()` donne un azimut GÉOGRAPHIQUE
   (vers le nord vrai). Le casque, lui, mesure un cap MAGNÉTIQUE dès
   qu'il dispose d'une boussole (BNO086). Dans le Bas-Saint-Laurent
   l'écart avoisine 16° ouest : assez pour manquer une placette.

   azimut_magnétique = azimut_vrai − déclinaison
   (déclinaison est NÉGATIVE vers l'ouest)

   COEFFICIENTS
   Le modèle est évalué ici, mais ses coefficients viennent du fichier
   officiel WMM.COF de la NOAA (domaine public, WMM2025 valide jusqu'à
   fin 2029). Ils ne sont volontairement PAS codés en dur : des valeurs
   approximatives produiraient une déclinaison fausse sans le signaler.
   Sans fichier chargé, magneticDeclination() renvoie null et l'app
   bascule sur une saisie manuelle.

   Fichier attendu : webapp/data/WMM.COF
   Source : https://www.ncei.noaa.gov/products/world-magnetic-model
   ============================================================ */

const EARTH_A_KM = 6378.137;              // WGS84 demi-grand axe
const EARTH_F = 1 / 298.257223563;        // WGS84 aplatissement
const EARTH_E2 = EARTH_F * (2 - EARTH_F); // excentricité au carré
const GEOMAG_REF_R = 6371.2;              // rayon de référence géomagnétique

const deg2rad = (d) => (d * Math.PI) / 180;
const rad2deg = (r) => (r * 180) / Math.PI;

let model = null;   // { epoch, name, validFrom, nMax, g[], h[], dg[], dh[] }

/** Index compact des coefficients : (n,m) → n(n+1)/2 + m */
const idx = (n, m) => (n * (n + 1)) / 2 + m;

/**
 * Analyse un fichier WMM.COF officiel.
 * Format : ligne d'en-tête « epoch  nom  date », puis des lignes
 * « n m gnm hnm dgnm dhnm », terminées par une ligne de 9999.
 */
export function loadModel(cofText) {
  const lines = String(cofText).split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  if (!lines.length) throw new Error('Fichier de coefficients vide.');

  const header = lines[0].split(/\s+/);
  const epoch = parseFloat(header[0]);
  if (!Number.isFinite(epoch)) {
    throw new Error('En-tête WMM.COF illisible (époque absente).');
  }

  const g = [], h = [], dg = [], dh = [];
  let nMax = 0;

  for (let i = 1; i < lines.length; i++) {
    if (lines[i].startsWith('9999')) break;
    const p = lines[i].split(/\s+/).map(Number);
    if (p.length < 6 || !Number.isFinite(p[0])) continue;
    const [n, m, gnm, hnm, dgnm, dhnm] = p;
    const k = idx(n, m);
    g[k] = gnm; h[k] = hnm; dg[k] = dgnm; dh[k] = dhnm;
    if (n > nMax) nMax = n;
  }

  if (nMax < 1) throw new Error('Aucun coefficient exploitable dans WMM.COF.');

  // Trous éventuels comblés par des zéros (h(n,0) vaut toujours 0).
  const size = idx(nMax, nMax) + 1;
  for (let k = 0; k < size; k++) {
    g[k] = g[k] || 0; h[k] = h[k] || 0; dg[k] = dg[k] || 0; dh[k] = dh[k] || 0;
  }

  model = { epoch, name: header[1] || 'WMM', nMax, g, h, dg, dh };
  return getModelInfo();
}

export function isModelLoaded() {
  return model !== null;
}

export function getModelInfo() {
  if (!model) return null;
  return {
    name: model.name,
    epoch: model.epoch,
    nMax: model.nMax,
    // Un WMM est publié pour 5 ans : au-delà, l'extrapolation se dégrade.
    validUntil: model.epoch + 5,
  };
}

/** Année décimale (le WMM extrapole linéairement depuis son époque). */
export function decimalYear(date = new Date()) {
  const year = date.getFullYear();
  const start = Date.UTC(year, 0, 1);
  const end = Date.UTC(year + 1, 0, 1);
  return year + (date.getTime() - start) / (end - start);
}

/**
 * Fonctions de Legendre associées, quasi-normalisation de Schmidt.
 * Transcription de MAG_PcupLow (bibliothèque NOAA, domaine public).
 * @param {number} nMax
 * @param {number} x  sin(latitude géocentrique)
 */
function legendre(nMax, x) {
  const size = idx(nMax, nMax) + 1;
  const P = new Float64Array(size);
  const dP = new Float64Array(size);
  const z = Math.sqrt((1 - x) * (1 + x));   // cos(latitude géocentrique)

  P[0] = 1;
  dP[0] = 0;

  // 1) Version normalisée « de Gauss »
  for (let n = 1; n <= nMax; n++) {
    for (let m = 0; m <= n; m++) {
      const k = idx(n, m);
      if (n === m) {
        const k1 = idx(n - 1, m - 1);
        P[k] = z * P[k1];
        dP[k] = z * dP[k1] + x * P[k1];
      } else if (n === 1 && m === 0) {
        const k1 = idx(n - 1, m);
        P[k] = x * P[k1];
        dP[k] = x * dP[k1] - z * P[k1];
      } else {
        const k2 = idx(n - 1, m);
        if (m > n - 2) {
          P[k] = x * P[k2];
          dP[k] = x * dP[k2] - z * P[k2];
        } else {
          const k1 = idx(n - 2, m);
          const c = ((n - 1) * (n - 1) - m * m) / ((2 * n - 1) * (2 * n - 3));
          P[k] = x * P[k2] - c * P[k1];
          dP[k] = x * dP[k2] - z * P[k2] - c * dP[k1];
        }
      }
    }
  }

  // 2) Rapport Gauss → Schmidt quasi-normalisé
  const s = new Float64Array(size);
  s[0] = 1;
  for (let n = 1; n <= nMax; n++) {
    s[idx(n, 0)] = (s[idx(n - 1, 0)] * (2 * n - 1)) / n;
    for (let m = 1; m <= n; m++) {
      s[idx(n, m)] = s[idx(n, m - 1)]
        * Math.sqrt(((n - m + 1) * (m === 1 ? 2 : 1)) / (n + m));
    }
  }
  for (let n = 1; n <= nMax; n++) {
    for (let m = 0; m <= n; m++) {
      const k = idx(n, m);
      P[k] *= s[k];
      dP[k] *= -s[k];   // signe : dérivée par rapport à la colatitude
    }
  }

  return { P, dP };
}

/**
 * Champ magnétique terrestre en un point.
 * @returns {{declination:number, inclination:number, intensity:number}|null}
 *   declination en degrés (positive vers l'est), intensity en nT.
 *   null si aucun modèle n'est chargé.
 */
export function magneticField(latitude, longitude, altitudeKm = 0, date = new Date()) {
  if (!model) return null;

  const { nMax, g, h, dg, dh, epoch } = model;
  const dt = decimalYear(date) - epoch;

  const phi = deg2rad(latitude);
  const lambda = deg2rad(longitude);
  const sinPhi = Math.sin(phi);
  const cosPhi = Math.cos(phi);

  // Géodésique → sphérique (géocentrique)
  const rc = EARTH_A_KM / Math.sqrt(1 - EARTH_E2 * sinPhi * sinPhi);
  const xp = (rc + altitudeKm) * cosPhi;
  const zp = (rc * (1 - EARTH_E2) + altitudeKm) * sinPhi;
  const r = Math.sqrt(xp * xp + zp * zp);
  const sinPhiPrime = zp / r;
  const cosPhiPrime = xp / r;
  const phiPrime = Math.asin(sinPhiPrime);

  const { P, dP } = legendre(nMax, sinPhiPrime);

  // cos(mλ) et sin(mλ) par récurrence
  const cosML = new Float64Array(nMax + 1);
  const sinML = new Float64Array(nMax + 1);
  cosML[0] = 1; sinML[0] = 0;
  cosML[1] = Math.cos(lambda); sinML[1] = Math.sin(lambda);
  for (let m = 2; m <= nMax; m++) {
    cosML[m] = cosML[m - 1] * cosML[1] - sinML[m - 1] * sinML[1];
    sinML[m] = cosML[m - 1] * sinML[1] + sinML[m - 1] * cosML[1];
  }

  // (a/r)^(n+2)
  const rrp = new Float64Array(nMax + 1);
  const ar = GEOMAG_REF_R / r;
  rrp[0] = ar * ar;
  for (let n = 1; n <= nMax; n++) rrp[n] = rrp[n - 1] * ar;

  let Bx = 0, By = 0, Bz = 0;
  for (let n = 1; n <= nMax; n++) {
    for (let m = 0; m <= n; m++) {
      const k = idx(n, m);
      const gt = g[k] + dt * dg[k];   // extrapolation séculaire
      const ht = h[k] + dt * dh[k];
      const c = gt * cosML[m] + ht * sinML[m];
      Bz -= rrp[n] * c * (n + 1) * P[k];
      By += rrp[n] * (gt * sinML[m] - ht * cosML[m]) * m * P[k];
      Bx -= rrp[n] * c * dP[k];
    }
  }

  if (Math.abs(cosPhiPrime) > 1e-10) {
    By /= cosPhiPrime;
  } else {
    // Aux pôles la formule dégénère. Capiq ne sert pas à ces latitudes :
    // on le signale plutôt que de renvoyer une valeur fausse.
    return null;
  }

  // Repère géocentrique → géodésique
  const psi = phiPrime - phi;
  const bxG = Bx * Math.cos(psi) - Bz * Math.sin(psi);
  const bzG = Bx * Math.sin(psi) + Bz * Math.cos(psi);

  const horizontal = Math.sqrt(bxG * bxG + By * By);
  return {
    declination: rad2deg(Math.atan2(By, bxG)),
    inclination: rad2deg(Math.atan2(bzG, horizontal)),
    intensity: Math.sqrt(horizontal * horizontal + bzG * bzG),
  };
}

/**
 * Déclinaison magnétique en degrés (positive vers l'est, négative vers
 * l'ouest — environ −16° dans le Bas-Saint-Laurent).
 * Renvoie null si aucun modèle n'est chargé.
 */
export function magneticDeclination(latitude, longitude, altitudeKm = 0, date = new Date()) {
  const f = magneticField(latitude, longitude, altitudeKm, date);
  return f ? f.declination : null;
}

/**
 * Convertit un azimut GÉOGRAPHIQUE en azimut MAGNÉTIQUE, celui que le
 * casque comprendra une fois équipé d'une boussole.
 * Renvoie null si la déclinaison est inconnue : mieux vaut ne rien
 * envoyer qu'un cap faux de 16°.
 */
export function trueToMagnetic(trueBearingDeg, latitude, longitude, date = new Date()) {
  const d = magneticDeclination(latitude, longitude, 0, date);
  if (d === null) return null;
  const v = (trueBearingDeg - d) % 360;
  return v < 0 ? v + 360 : v;
}

/** Charge le fichier de coefficients livré avec l'application. */
export async function loadDefaultModel(url = './data/WMM.COF') {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`WMM.COF introuvable (${res.status}).`);
  return loadModel(await res.text());
}
