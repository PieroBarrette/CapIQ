/* ============================================================
   Capiq — Import GPX
   GSFNav (Groupe Système Forêt) exporte ses données de terrain en GPX
   et en .geogsf. Le GPX étant un format standard XML, il s'analyse
   intégralement dans le navigateur — donc hors ligne, sans serveur.

   Le .geogsf est propriétaire : sa prise en charge demandera sa
   spécification. Le point d'entrée est prévu (voir parseGeogsf).
   ============================================================ */

import { Waypoint } from '../models/navigation_model.js';

const GPX_NS = 'http://www.topografix.com/GPX/1/1';

/** Lit un attribut numérique, ou null s'il est absent/invalide. */
function num(el, attr) {
  const v = parseFloat(el.getAttribute(attr));
  return Number.isFinite(v) ? v : null;
}

/** Texte du premier enfant portant ce nom, ou '' */
function childText(el, tag) {
  // getElementsByTagName ignore le namespace : robuste face aux GPX 1.0/1.1
  const found = el.getElementsByTagName(tag)[0];
  return found ? found.textContent.trim() : '';
}

/**
 * Convertit un élément <wpt>/<rtept>/<trkpt> en Waypoint.
 * Retourne null si les coordonnées sont absentes ou hors limites.
 */
function pointToWaypoint(el, fallbackName) {
  const latitude = num(el, 'lat');
  const longitude = num(el, 'lon');
  if (latitude === null || longitude === null) return null;

  const eleText = childText(el, 'ele');
  const altitude = eleText ? parseFloat(eleText) : null;
  const name = childText(el, 'name') || fallbackName;

  try {
    return new Waypoint({ latitude, longitude, altitude, name });
  } catch {
    return null;  // coordonnées hors plage : point ignoré
  }
}

/**
 * Analyse un contenu GPX.
 * @param {string} xmlText
 * @returns {{waypoints: Waypoint[], routes: Array, trackPointCount: number, warnings: string[]}}
 *
 * Les <wpt> et les points de route <rtept> deviennent des waypoints
 * navigables. Les <trkpt> (traces enregistrées) sont comptés mais pas
 * convertis : une trace contient facilement des milliers de points, ce
 * qui n'a pas de sens dans une liste de destinations.
 */
export function parseGpx(xmlText) {
  const warnings = [];
  const doc = new DOMParser().parseFromString(xmlText, 'application/xml');

  // DOMParser ne lève pas : il produit un document <parsererror>.
  const failure = doc.getElementsByTagName('parsererror')[0];
  if (failure) {
    throw new Error('Fichier GPX illisible (XML invalide).');
  }
  if (!doc.documentElement || doc.documentElement.nodeName.toLowerCase() !== 'gpx') {
    throw new Error('Ce fichier n\'est pas un GPX.');
  }

  const waypoints = [];
  const seen = new Set();

  const push = (wp) => {
    if (!wp) return;
    // Dédoublonnage : GSFNav peut exporter le même point en <wpt> et en
    // <rtept>. On tolère ~1 cm d'écart de coordonnées.
    const key = `${wp.latitude.toFixed(7)},${wp.longitude.toFixed(7)}`;
    if (seen.has(key)) return;
    seen.add(key);
    waypoints.push(wp);
  };

  const wpts = doc.getElementsByTagName('wpt');
  for (let i = 0; i < wpts.length; i++) {
    push(pointToWaypoint(wpts[i], `Point ${i + 1}`));
  }

  const routes = [];
  const rtes = doc.getElementsByTagName('rte');
  for (let r = 0; r < rtes.length; r++) {
    const routeName = childText(rtes[r], 'name') || `Route ${r + 1}`;
    const pts = rtes[r].getElementsByTagName('rtept');
    const routePoints = [];
    for (let i = 0; i < pts.length; i++) {
      const wp = pointToWaypoint(pts[i], `${routeName} — ${i + 1}`);
      if (wp) {
        routePoints.push(wp);
        push(wp);
      }
    }
    if (routePoints.length) routes.push({ name: routeName, points: routePoints });
  }

  const trackPointCount = doc.getElementsByTagName('trkpt').length;
  if (trackPointCount > 0) {
    warnings.push(
      `${trackPointCount} point(s) de trace ignoré(s) : les traces enregistrées `
      + 'ne sont pas des destinations. Seuls les points et les routes sont importés.'
    );
  }
  if (waypoints.length === 0) {
    warnings.push('Aucun point ni route exploitable dans ce fichier.');
  }

  return { waypoints, routes, trackPointCount, warnings };
}

/**
 * Format .geogsf de GSFNav — NON IMPLÉMENTÉ.
 * Format propriétaire : sa prise en charge nécessite la spécification
 * ou des fichiers d'exemple. En attendant, exporter en GPX depuis GSFNav.
 */
export function parseGeogsf() {
  throw new Error(
    'Le format .geogsf n\'est pas encore pris en charge. '
    + 'Exportez vos données en GPX depuis GSFNav.'
  );
}

/** Lit un File (input type=file) et l'analyse selon son extension. */
export async function importFile(file) {
  const text = await file.text();
  if (/\.geogsf$/i.test(file.name)) return parseGeogsf(text);
  return parseGpx(text);
}
