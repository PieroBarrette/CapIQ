/* ============================================================
   Capiq — NavigationService
   Mathématiques de navigation (actives dès V0.1 pour les tests)
   et suivi GPS → cap à suivre (prêt pour V0.2).

   V0.2 prévu : position GPS du téléphone + waypoint cible
   → calculateBearing() → sendTargetAzimuth() vers le casque
   → guidage automatique jusqu'au point (cartes OSM hors ligne,
   fichiers GPX/GeoJSON issus de QGIS, points forestiers, GSFNAV).
   ============================================================ */

const EARTH_RADIUS_M = 6371000;

const toRad = (deg) => (deg * Math.PI) / 180;
const toDeg = (rad) => (rad * 180) / Math.PI;

/** Normalise un angle en [0, 360[. */
export function normalize360(deg) {
  const d = deg % 360;
  return d < 0 ? d + 360 : d;
}

/**
 * Ramène un angle en [-180, +180[.
 * CONVENTION CAPIQ (identique au firmware) :
 *   erreur = wrap180(cible - cap) ; positif = tourner à DROITE.
 */
export function wrap180(deg) {
  let d = (deg + 180) % 360;
  if (d < 0) d += 360;
  return d - 180;
}

/**
 * Distance grand cercle (haversine) entre deux points, en mètres.
 * Précision largement suffisante pour la navigation forestière.
 * @param {{latitude:number, longitude:number}} a
 * @param {{latitude:number, longitude:number}} b
 */
export function calculateDistance(a, b) {
  const p1 = toRad(a.latitude);
  const p2 = toRad(b.latitude);
  const dp = toRad(b.latitude - a.latitude);
  const dl = toRad(b.longitude - a.longitude);
  const h =
    Math.sin(dp / 2) ** 2 +
    Math.cos(p1) * Math.cos(p2) * Math.sin(dl / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h)));
}

/**
 * Azimut initial (géographique, 0-360°) du point a vers le point b.
 * NOTE : c'est un azimut VRAI. Si le casque travaille en cap magnétique
 * (MAG_DECLINATION_DEG = 0 dans le firmware), appliquer la déclinaison
 * locale avant l'envoi.
 */
export function calculateBearing(a, b) {
  const p1 = toRad(a.latitude);
  const p2 = toRad(b.latitude);
  const dl = toRad(b.longitude - a.longitude);
  const y = Math.sin(dl) * Math.cos(p2);
  const x = Math.cos(p1) * Math.sin(p2) - Math.sin(p1) * Math.cos(p2) * Math.cos(dl);
  return normalize360(toDeg(Math.atan2(y, x)));
}

/**
 * Problème géodésique DIRECT : point atteint en partant de `from`, en
 * suivant `bearingDeg` sur `distanceM` mètres (grand cercle).
 * C'est l'inverse de calculateBearing/calculateDistance.
 */
export function destinationPoint(from, bearingDeg, distanceM) {
  const delta = distanceM / EARTH_RADIUS_M;   // distance angulaire
  const theta = toRad(bearingDeg);
  const phi1 = toRad(from.latitude);
  const lambda1 = toRad(from.longitude);

  const sinPhi2 = Math.sin(phi1) * Math.cos(delta)
                + Math.cos(phi1) * Math.sin(delta) * Math.cos(theta);
  const phi2 = Math.asin(Math.min(1, Math.max(-1, sinPhi2)));
  const lambda2 = lambda1 + Math.atan2(
    Math.sin(theta) * Math.sin(delta) * Math.cos(phi1),
    Math.cos(delta) - Math.sin(phi1) * sinPhi2
  );

  return {
    latitude: toDeg(phi2),
    // Ramène la longitude dans [-180, 180[
    longitude: ((toDeg(lambda2) + 540) % 360) - 180,
  };
}

/* ============================================================
   Grappes de micro-placettes

   Protocole d'inventaire : on relève une placette tous les `spacingM`
   mètres le long d'un azimut, jusqu'à `count` placettes (10 en usage
   courant). La PREMIÈRE placette est au point de départ lui-même.

   Si un obstacle barre la route (lac, falaise, chemin), le technicien
   vire de 90° et poursuit son inventaire dans la nouvelle direction
   sans changer le nombre total de placettes.
   ============================================================ */

export const DEFAULT_CLUSTER_COUNT = 10;

/**
 * Engendre les points d'une grappe.
 * @param {{latitude:number, longitude:number}} start  placette n° 1
 * @param {number} azimuthDeg  azimut GÉOGRAPHIQUE (nord vrai)
 * @param {number} spacingM    espacement en mètres
 * @param {number} count       nombre total de placettes
 */
export function generateCluster(start, azimuthDeg, spacingM, count = DEFAULT_CLUSTER_COUNT) {
  if (!(spacingM > 0)) throw new Error('L\'espacement doit être supérieur à 0 m.');
  if (!(count >= 1)) throw new Error('Il faut au moins une placette.');

  const points = [{ latitude: start.latitude, longitude: start.longitude }];
  for (let i = 1; i < count; i++) {
    points.push(destinationPoint(points[i - 1], azimuthDeg, spacingM));
  }
  return points;
}

/**
 * Vire de 90° à partir d'une placette atteinte, et réengendre les
 * suivantes dans la nouvelle direction.
 *
 * Les placettes 0..fromIndex sont CONSERVÉES telles quelles : elles ont
 * déjà été relevées sur le terrain, il serait faux de les déplacer.
 * Le virage part donc de la dernière placette atteinte, ce qui préserve
 * l'espacement et rend la grappe reproductible.
 *
 * @param {Array} points     grappe courante
 * @param {number} fromIndex index (0-based) de la dernière placette atteinte
 * @param {number} azimuthDeg azimut suivi jusqu'ici
 * @param {number} spacingM
 * @param {'droite'|'gauche'} side  côté du virage
 * @returns {{points: Array, azimuth: number}}
 */
export function pivotCluster(points, fromIndex, azimuthDeg, spacingM, side = 'droite') {
  if (fromIndex < 0 || fromIndex >= points.length) {
    throw new Error('Placette de virage hors de la grappe.');
  }
  if (fromIndex === points.length - 1) {
    throw new Error('La grappe est terminée : plus aucune placette à replacer.');
  }

  const newAzimuth = normalize360(azimuthDeg + (side === 'gauche' ? -90 : 90));
  const out = points.slice(0, fromIndex + 1).map((p) => ({ ...p }));
  for (let i = fromIndex + 1; i < points.length; i++) {
    out.push(destinationPoint(out[out.length - 1], newAzimuth, spacingM));
  }
  return { points: out, azimuth: newAzimuth };
}

/** Convertit une GeolocationPosition du navigateur en point {latitude, longitude}. */
export function positionToPoint(position) {
  return {
    latitude: position.coords.latitude,
    longitude: position.coords.longitude,
    altitude: position.coords.altitude,
    accuracy: position.coords.accuracy,
  };
}

/**
 * Suivi GPS et guidage vers un waypoint.
 *
 * Le suivi de position et le choix de la destination sont volontairement
 * SÉPARÉS : on veut afficher l'état du GPS (précision, coordonnées) dès
 * son activation, avant même de savoir où l'on va.
 *
 * Événements :
 *   'position'  → { latitude, longitude, altitude, accuracy }  à chaque point
 *   'navupdate' → { distanceM, bearingDeg, position, waypoint } si destination
 *   'navpaused' → { error }  (GPS indisponible, refusé ou perdu)
 */
export class NavigationService extends EventTarget {
  constructor() {
    super();
    this._watchId = null;
    this._waypoint = null;
    this._last = null;
  }

  get active() { return this._watchId !== null; }
  get destination() { return this._waypoint; }
  get lastPosition() { return this._last; }

  /** Démarre le suivi de position. Sans effet s'il tourne déjà. */
  startTracking() {
    if (!('geolocation' in navigator)) {
      throw new Error('Géolocalisation non disponible sur cet appareil.');
    }
    if (this._watchId !== null) return;

    this._watchId = navigator.geolocation.watchPosition(
      (position) => {
        const here = positionToPoint(position);
        this._last = here;
        this.dispatchEvent(new CustomEvent('position', { detail: here }));
        if (this._waypoint) this._emitNav(here);
      },
      (error) => {
        this.dispatchEvent(new CustomEvent('navpaused', { detail: { error } }));
      },
      // enableHighAccuracy : indispensable sous couvert forestier, au prix
      // de la batterie. maximumAge court : on veut une position fraîche.
      { enableHighAccuracy: true, maximumAge: 2000, timeout: 20000 }
    );
  }

  /** Fixe (ou retire avec null) la destination courante. */
  setDestination(waypoint) {
    this._waypoint = waypoint || null;
    if (this._waypoint && this._last) this._emitNav(this._last);
  }

  /** Démarre le suivi ET fixe la destination (API historique). */
  navigateToWaypoint(waypoint) {
    this.startTracking();
    this.setDestination(waypoint);
  }

  stop() {
    if (this._watchId !== null) {
      navigator.geolocation.clearWatch(this._watchId);
      this._watchId = null;
    }
    this._waypoint = null;
    this._last = null;
  }

  _emitNav(here) {
    this.dispatchEvent(new CustomEvent('navupdate', {
      detail: {
        distanceM: calculateDistance(here, this._waypoint),
        bearingDeg: calculateBearing(here, this._waypoint),
        position: here,
        waypoint: this._waypoint,
      },
    }));
  }
}
