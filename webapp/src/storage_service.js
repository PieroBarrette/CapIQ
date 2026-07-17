/* ============================================================
   Capiq V0.1 — StorageService
   Persistance locale (paramètres, cible, waypoints futurs).

   Implémentation : localStorage (suffisant pour des petits JSON).
   Toute l'app passe par ce module : migrer vers IndexedDB plus
   tard (cartes hors ligne, logs, traces GPX) ne touchera que ce
   fichier.
   ============================================================ */

const KEYS = {
  settings:  'capiq.settings.v1',
  target:    'capiq.target.v1',
  waypoints: 'capiq.waypoints.v1',
};

export const DEFAULT_SETTINGS = {
  deadzone: 2,        // ± degrés "aligné"
  brightness: 60,     // % LED
  rate: 5,            // Hz télémétrie
  offset: 0,          // ° correction de montage
};

function readJSON(key) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function writeJSON(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
    return true;
  } catch {
    return false; // quota plein / navigation privée : l'app reste utilisable
  }
}

// ---- Paramètres --------------------------------------------------------

export function loadSettings() {
  return { ...DEFAULT_SETTINGS, ...(readJSON(KEYS.settings) || {}) };
}

export function saveSettings(settings) {
  return writeJSON(KEYS.settings, settings);
}

// ---- Azimut cible ------------------------------------------------------

/** Retourne le dernier azimut cible (nombre) ou null. */
export function loadTarget() {
  const v = readJSON(KEYS.target);
  return typeof v === 'number' && isFinite(v) ? v : null;
}

export function saveTarget(deg) {
  return writeJSON(KEYS.target, deg);
}

// ---- Waypoints (préparation navigation GPS V0.2) -----------------------

/** Retourne un tableau d'objets waypoint bruts ({latitude, longitude, ...}). */
export function loadWaypoints() {
  const v = readJSON(KEYS.waypoints);
  return Array.isArray(v) ? v : [];
}

export function saveWaypoints(waypoints) {
  return writeJSON(KEYS.waypoints, waypoints);
}
