#pragma once
#include <Arduino.h>

// ============================================================
// BluetoothManager — serveur BLE Capiq (pile NimBLE)
//
// Service principal : CAPIQ_SERVICE_UUID (voir config.h)
//   TARGET    (WRITE)       : azimut cible — {"target":90} ou "90"
//   TELEMETRY (READ/NOTIFY) : {"target":90,"heading":87.5,"error":2.5,
//                              "battery":100,"pitch":1.2,"roll":-0.8}
//   STATUS    (READ/NOTIFY) : état système (fw, mode, imu, cal, réglages)
//   COMMAND   (WRITE)       : {"cmd":"set"|"cal_mag"|"cal_imu"|"reset_cal", ...}
// Service standard 0x180F : Battery Level 0x2A19 (READ/NOTIFY)
//
// Threading : les callbacks BLE tournent sur la tâche hôte NimBLE
// (cœur 0). Ils ne font que déposer les écritures dans des "boîtes aux
// lettres" protégées ; loop() les récupère via fetchTargetAzimuth() /
// fetchCommand(). Aucun traitement lourd dans les callbacks.
//
// Évolution prévue (GPS, waypoints, logs) : ajouter des caractéristiques
// ca910005+, ou des commandes JSON sur COMMAND — l'app web ignore les
// champs inconnus.
// ============================================================

struct TelemetryPacket {
  bool  hasTarget;
  float target;    // degrés 0..360
  float heading;   // degrés 0..360
  float error;     // degrés -180..+180 (cible - cap)
  int   battery;   // 0..100 %
  float pitch;     // degrés
  float roll;      // degrés
};

class BluetoothManager {
public:
  // Démarre la pile BLE, crée le service et lance la publicité.
  bool begin(const char* deviceName);

  bool isConnected() const;

  // Récupère (une seule fois) le dernier azimut cible écrit par le téléphone.
  // Retourne true si une nouvelle valeur était en attente.
  bool fetchTargetAzimuth(float& outDeg);

  // Récupère (une seule fois) la dernière commande JSON écrite.
  bool fetchCommand(String& outJson);

  // Sérialise et notifie la télémétrie (appelé à la cadence réglée).
  void notifyTelemetry(const TelemetryPacket& t);

  // Met à jour la caractéristique STATUS (+ notification si connecté).
  void setStatus(const String& json);

  // Met à jour le niveau de batterie (service standard 0x180F).
  void setBatteryLevel(uint8_t percent);
};
