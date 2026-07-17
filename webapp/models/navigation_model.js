/* ============================================================
   Capiq — Modèles de navigation
   Utilisés dès V0.1 pour le stockage, pleinement exploités en
   V0.2 (GPS téléphone, cartes hors ligne, GPX/GeoJSON, QGIS).
   ============================================================ */

export const WAYPOINT_SCHEMA_VERSION = 1;

export class Waypoint {
  /**
   * @param {object} p
   * @param {number} p.latitude   degrés décimaux WGS84 (-90..90)
   * @param {number} p.longitude  degrés décimaux WGS84 (-180..180)
   * @param {number|null} [p.altitude] mètres (optionnel)
   * @param {string} [p.name]
   */
  constructor({ latitude, longitude, altitude = null, name = '' }) {
    if (!Number.isFinite(latitude) || latitude < -90 || latitude > 90) {
      throw new Error(`Latitude invalide : ${latitude}`);
    }
    if (!Number.isFinite(longitude) || longitude < -180 || longitude > 180) {
      throw new Error(`Longitude invalide : ${longitude}`);
    }
    this.latitude = latitude;
    this.longitude = longitude;
    this.altitude = Number.isFinite(altitude) ? altitude : null;
    this.name = String(name || '');
  }

  toJSON() {
    return {
      v: WAYPOINT_SCHEMA_VERSION,
      latitude: this.latitude,
      longitude: this.longitude,
      altitude: this.altitude,
      name: this.name,
    };
  }

  static fromJSON(obj) {
    return new Waypoint(obj || {});
  }

  /** Import futur GeoJSON (Point) — format de sortie QGIS. */
  static fromGeoJSON(feature) {
    const [longitude, latitude, altitude = null] = feature?.geometry?.coordinates || [];
    return new Waypoint({
      latitude,
      longitude,
      altitude,
      name: feature?.properties?.name || '',
    });
  }
}
