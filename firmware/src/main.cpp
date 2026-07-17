// ============================================================
// Capiq V0.1 — main.cpp
// Orchestration : IMU (>=100 Hz) → erreur directionnelle → LED,
// serveur BLE (cible/commandes entrantes, télémétrie sortante),
// réglages persistants (NVS), console série de banc d'essai.
//
// Convention d'erreur (voir config.h) :
//   erreur = wrap180(cible - cap) ; positif = tourner à DROITE.
// ============================================================

#include <Arduino.h>
#include <Preferences.h>
#include <ArduinoJson.h>
#include "config.h"
#include "imu_manager.h"
#include "led_manager.h"
#include "bluetooth_manager.h"

// ---- Réglages utilisateur (modifiables par l'app, persistés en NVS) ----
struct Settings {
  float   deadzoneDeg   = DEFAULT_DEADZONE_DEG;
  uint8_t brightnessPct = LED_DEFAULT_BRIGHTNESS_PCT;
  uint8_t telemetryHz   = TELEMETRY_DEFAULT_HZ;   // 1..20
  float   headingOffset = 0.0f;                   // correction de montage (deg)
};

static IMUManager       imu;
static LEDManager       led;
static BluetoothManager ble;
static Settings         settings;

static float    targetAzimuth = 0.0f;
static bool     hasTarget     = false;
static bool     calibrating   = false;
static bool     prevConnected = false;
static uint32_t lastTelemetryMs = 0;
static uint32_t lastStatusMs    = 0;
static String   lastStatusJson;
static String   serialLine;

// ------------------------------------------------------------
// Batterie — V0.1 : alimentation USB, valeur fixe.
// V0.2 : lire PIN_BATTERY_ADC via pont diviseur (Li-ion 18650),
// voir docs/HARDWARE.md.
// ------------------------------------------------------------
static int readBatteryPercent() { return 100; }

// ---- Persistance -------------------------------------------------------
static void loadState() {
  Preferences prefs;
  prefs.begin(NVS_NAMESPACE, true);
  settings.deadzoneDeg   = prefs.getFloat("dz", DEFAULT_DEADZONE_DEG);
  settings.brightnessPct = prefs.getUChar("bri", LED_DEFAULT_BRIGHTNESS_PCT);
  settings.telemetryHz   = prefs.getUChar("thz", TELEMETRY_DEFAULT_HZ);
  settings.headingOffset = prefs.getFloat("off", 0.0f);
  targetAzimuth          = prefs.getFloat("tgt", 0.0f);
  hasTarget              = prefs.getBool("htgt", false);
  prefs.end();
}

static void saveSettings() {
  Preferences prefs;
  prefs.begin(NVS_NAMESPACE, false);
  prefs.putFloat("dz", settings.deadzoneDeg);
  prefs.putUChar("bri", settings.brightnessPct);
  prefs.putUChar("thz", settings.telemetryHz);
  prefs.putFloat("off", settings.headingOffset);
  prefs.end();
}

static void saveTarget() {
  // Écrit à chaque envoi de cible (usage terrain : quelques fois par sortie,
  // sans risque pour l'endurance NVS ~100k cycles).
  Preferences prefs;
  prefs.begin(NVS_NAMESPACE, false);
  prefs.putFloat("tgt", targetAzimuth);
  prefs.putBool("htgt", hasTarget);
  prefs.end();
}

static void applySettings() {
  led.setDeadzone(settings.deadzoneDeg);
  led.setBrightnessPercent(settings.brightnessPct);
  imu.setHeadingOffset(settings.headingOffset);
}

// ---- Statut ------------------------------------------------------------
static String buildStatusJson() {
  JsonDocument doc;
  doc["fw"]        = CAPIQ_FW_VERSION;
  doc["mode"]      = ledModeName(led.getMode());
  doc["imu"]       = imu.isHealthy();
  doc["mag"]       = imu.hasMagnetometer();
  doc["cal"]       = imu.isCalibrated();
  doc["rate"]      = roundf(imu.getMeasuredRateHz());
  doc["deadzone"]  = settings.deadzoneDeg;
  doc["brightness"] = settings.brightnessPct;
  doc["rateHz"]    = settings.telemetryHz;
  doc["offset"]    = settings.headingOffset;
  doc["hasTarget"] = hasTarget;
  String out;
  serializeJson(doc, out);
  return out;
}

static void pushStatus(bool force = false) {
  const String s = buildStatusJson();
  if (force || s != lastStatusJson) {
    lastStatusJson = s;
    ble.setStatus(s);
  }
}

// ---- Modes LED ---------------------------------------------------------
static void updateLedMode() {
  LedMode wanted;
  if (!imu.isHealthy())      wanted = LedMode::ERROR;
  else if (calibrating)      wanted = LedMode::CALIBRATION;
  else if (!hasTarget)       wanted = LedMode::CONNECTION;  // en attente de cible
  else                       wanted = LedMode::DIRECTION;
  if (led.getMode() != wanted) led.setMode(wanted);
}

// ---- Calibrations (bloquantes — la tâche LED continue d'animer) --------
static void runCalibration(bool magnetometer) {
  if (!imu.isHealthy()) return;
  calibrating = true;
  led.setMode(LedMode::CALIBRATION);
  pushStatus(true);
  const bool ok = magnetometer ? imu.calibrateMag() : imu.calibrateGyroAccel();
  calibrating = false;
  led.flash(ok ? 0 : 255, ok ? 255 : 0, 0, 0, 500);
  updateLedMode();
  pushStatus(true);
}

// ---- Cible et commandes ------------------------------------------------
static void acceptTarget(float deg) {
  targetAzimuth = normalize360(deg);
  hasTarget = true;
  saveTarget();
  led.flash(0, 0, 0, 120, 150);  // accusé de réception blanc
  Serial.printf("[APP] Nouvelle cible : %.1f deg\n", targetAzimuth);
}

static void handleCommand(const String& json) {
  JsonDocument doc;
  if (deserializeJson(doc, json) != DeserializationError::Ok) {
    Serial.printf("[APP] Commande JSON invalide : %s\n", json.c_str());
    return;
  }
  const char* cmd = doc["cmd"] | "";

  if (strcmp(cmd, "set") == 0) {
    if (doc["deadzone"].is<float>())  settings.deadzoneDeg   = constrain(doc["deadzone"].as<float>(), 0.0f, 45.0f);
    if (doc["brightness"].is<int>())  settings.brightnessPct = constrain(doc["brightness"].as<int>(), 0, 100);
    if (doc["rate"].is<int>())        settings.telemetryHz   = constrain(doc["rate"].as<int>(), 1, 20);
    if (doc["offset"].is<float>())    settings.headingOffset = wrap180(doc["offset"].as<float>());
    saveSettings();
    applySettings();
    pushStatus(true);
    Serial.println(F("[APP] Reglages recus et appliques"));
  } else if (strcmp(cmd, "cal_mag") == 0) {
    runCalibration(true);
  } else if (strcmp(cmd, "cal_imu") == 0) {
    runCalibration(false);
  } else if (strcmp(cmd, "reset_cal") == 0) {
    imu.clearCalibration();
    pushStatus(true);
  } else {
    Serial.printf("[APP] Commande inconnue : %s\n", cmd);
  }
}

// ---- Console série de banc d'essai ------------------------------------
static void printHelp() {
  Serial.println(F("--- Console Capiq ---"));
  Serial.println(F("t <deg>  definir l'azimut cible (ex: t 90)"));
  Serial.println(F("c        afficher le cap actuel"));
  Serial.println(F("g        calibration gyro/accel (immobile ~5 s)"));
  Serial.println(F("m        calibration magnetometre (faire des 8 ~20 s)"));
  Serial.println(F("r        effacer la calibration"));
  Serial.println(F("b <pct>  luminosite LED 0-100"));
  Serial.println(F("i        infos systeme (JSON statut)"));
  Serial.println(F("h        cette aide"));
}

static void processSerialCommand(String line) {
  line.trim();
  if (line.isEmpty()) return;
  const char c = line[0];
  const String arg = line.length() > 1 ? line.substring(1) : String();
  switch (c) {
    case 't': acceptTarget(arg.toFloat()); break;
    case 'c':
      Serial.printf("Cap: %.1f deg | pitch: %.1f | roll: %.1f | %.0f Hz\n",
                    imu.getHeading(), imu.getPitch(), imu.getRoll(), imu.getMeasuredRateHz());
      break;
    case 'g': runCalibration(false); break;
    case 'm': runCalibration(true); break;
    case 'r': imu.clearCalibration(); break;
    case 'b':
      settings.brightnessPct = constrain(arg.toInt(), 0, 100);
      saveSettings();
      applySettings();
      Serial.printf("Luminosite: %d %%\n", settings.brightnessPct);
      break;
    case 'i': Serial.println(buildStatusJson()); break;
    default: printHelp(); break;
  }
}

static void handleSerial() {
  while (Serial.available()) {
    const char ch = (char)Serial.read();
    if (ch == '\n' || ch == '\r') {
      if (serialLine.length()) processSerialCommand(serialLine);
      serialLine = "";
    } else if (serialLine.length() < 64) {
      serialLine += ch;
    }
  }
}

// ------------------------------------------------------------
void setup() {
  Serial.begin(115200);
  delay(200);
  Serial.printf("\n=== Capiq V%s ===\n", CAPIQ_FW_VERSION);

  loadState();

  led.begin();
  led.setMode(LedMode::BOOT);

  if (!imu.begin()) {
    Serial.println(F("[MAIN] IMU indisponible — mode ERREUR (le BLE reste actif)"));
  }

  ble.begin(CAPIQ_DEVICE_NAME);
  applySettings();

  delay(600);  // laisse finir l'animation de démarrage
  updateLedMode();
  printHelp();
}

void loop() {
  // 1. IMU aussi souvent que possible (le capteur cadence à 200 Hz interne)
  imu.update();

  // 2. Entrées BLE (déposées par les callbacks, consommées ici)
  float newTarget;
  if (ble.fetchTargetAzimuth(newTarget)) acceptTarget(newTarget);
  String cmdJson;
  if (ble.fetchCommand(cmdJson)) handleCommand(cmdJson);

  // 3. Console série
  handleSerial();

  // 4. Erreur directionnelle → LED
  const float error = hasTarget ? wrap180(targetAzimuth - imu.getHeading()) : 0.0f;
  led.setDirectionError(error, hasTarget);
  updateLedMode();

  // 5. Événements de connexion (flash visuel)
  const bool connected = ble.isConnected();
  if (connected != prevConnected) {
    prevConnected = connected;
    if (connected) led.flash(0, 180, 60, 0, 300);
    else           led.flash(255, 120, 0, 0, 300);
    pushStatus(true);
  }

  // 6. Télémétrie à la cadence réglée
  const uint32_t now = millis();
  const uint32_t telemetryInterval = 1000 / max<uint8_t>(settings.telemetryHz, 1);
  if (connected && now - lastTelemetryMs >= telemetryInterval) {
    lastTelemetryMs = now;
    const int batt = readBatteryPercent();
    ble.notifyTelemetry({hasTarget, targetAzimuth, imu.getHeading(), error,
                         batt, imu.getPitch(), imu.getRoll()});
    ble.setBatteryLevel((uint8_t)batt);
  }

  // 7. Statut (au plus 1 Hz, seulement s'il change)
  if (now - lastStatusMs >= 1000) {
    lastStatusMs = now;
    pushStatus();
  }
}
