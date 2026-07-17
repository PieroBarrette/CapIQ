#pragma once
#include <Arduino.h>
#include <math.h>

// ============================================================
// Capiq V0.1 — Configuration centrale
// Tout réglage matériel ou logiciel se fait ICI.
// ============================================================

#define CAPIQ_FW_VERSION  "0.1.0"
#define CAPIQ_DEVICE_NAME "Capiq"

// ------------------------------------------------------------
// Broches
// GPIO choisis pour éviter :
//   - broches de strapping au boot (ESP32: 0, 2, 5, 12, 15 / S3: 0, 3, 45, 46)
//   - broches réservées au flash SPI (ESP32: 6-11 / S3: 26-32)
//   - broches input-only pour les sorties (ESP32: 34-39)
// Le BLE n'utilise aucun GPIO (radio interne) : pas de conflit possible.
// ------------------------------------------------------------
#if defined(CONFIG_IDF_TARGET_ESP32S3)
constexpr int PIN_I2C_SDA  = 8;   // MPU-9250 SDA (I2C par défaut DevKitC-1)
constexpr int PIN_I2C_SCL  = 9;   // MPU-9250 SCL
constexpr int PIN_LED_DATA = 13;  // SK6812 DATA (via résistance série ~330 Ω)
constexpr int PIN_BATTERY_ADC = 4;  // FUTUR : pont diviseur batterie
#else
constexpr int PIN_I2C_SDA  = 21;  // MPU-9250 SDA
constexpr int PIN_I2C_SCL  = 22;  // MPU-9250 SCL
constexpr int PIN_LED_DATA = 13;  // SK6812 DATA (via résistance série ~330 Ω)
constexpr int PIN_BATTERY_ADC = 34; // FUTUR : input-only, parfait pour l'ADC
#endif

// ------------------------------------------------------------
// I2C / IMU
// ------------------------------------------------------------
constexpr uint32_t I2C_CLOCK_HZ = 400000;
constexpr uint8_t  IMU_I2C_ADDR = 0x68;   // AD0 à GND (0x69 si AD0 à 3.3 V)

// Inverser si le module IMU est monté tête en bas sur la casquette.
constexpr float IMU_YAW_SIGN = +1.0f;

// Déclinaison magnétique.
//   0.0  = le cap affiché est un cap MAGNÉTIQUE (défaut — cohérent avec une
//          boussole de poche non corrigée).
//   Pour un cap GÉOGRAPHIQUE (vrai nord), entrer la déclinaison locale,
//   ex. ~ -16° (ouest) dans la région de Rimouski-Neigette en 2026.
//   À vérifier : https://geomag.nrcan.gc.ca/calc/mdcal-fr.php
constexpr float MAG_DECLINATION_DEG = 0.0f;

// Lissage du cap (moyenne mobile exponentielle circulaire).
// 1.0 = aucun lissage ; 0.1 = très amorti. 0.25 = bon compromis casquette.
constexpr float HEADING_SMOOTHING_ALPHA = 0.25f;

// ------------------------------------------------------------
// LED SK6812 RGBW
// ------------------------------------------------------------
constexpr uint16_t LED_COUNT    = 15;    // segment utilisé sur la palette (144/m → ~10 cm)
constexpr bool     LED_REVERSED = false; // true si l'index 0 est à DROITE du porteur

// Plafond de courant : à pleine blancheur, chaque SK6812 RGBW tire ~80 mA.
// 15 LED × 80 mA = 1.2 A — trop pour l'USB. Le plafond logiciel limite la
// luminosité maximale réelle (160/255 ≈ 63 %), et le mode direction n'allume
// que quelques LED à la fois. NE PAS augmenter sans alimentation dédiée.
constexpr uint8_t  LED_MAX_BRIGHTNESS = 160;
constexpr uint8_t  LED_DEFAULT_BRIGHTNESS_PCT = 60; // % — réglable par l'app
constexpr uint16_t LED_FRAME_HZ = 30;               // fréquence de rendu

// Mapping erreur → position : ±DIRECTION_FULLSCALE_DEG couvre la demi-bande.
constexpr float DIRECTION_FULLSCALE_DEG = 90.0f;
constexpr float DEFAULT_DEADZONE_DEG    = 2.0f;     // ± zone morte "aligné"

// ------------------------------------------------------------
// BLE — les UUID doivent rester IDENTIQUES à webapp/src/ble_service.js
// ------------------------------------------------------------
#define CAPIQ_SERVICE_UUID        "ca910000-56e8-4b3a-9a2f-d3f1a2b4c5d6"
#define CAPIQ_CHAR_TARGET_UUID    "ca910001-56e8-4b3a-9a2f-d3f1a2b4c5d6" // WRITE : azimut cible
#define CAPIQ_CHAR_TELEMETRY_UUID "ca910002-56e8-4b3a-9a2f-d3f1a2b4c5d6" // READ/NOTIFY : télémétrie JSON
#define CAPIQ_CHAR_STATUS_UUID    "ca910003-56e8-4b3a-9a2f-d3f1a2b4c5d6" // READ/NOTIFY : état JSON
#define CAPIQ_CHAR_COMMAND_UUID   "ca910004-56e8-4b3a-9a2f-d3f1a2b4c5d6" // WRITE : commandes JSON
// Le niveau de batterie passe aussi par le service standard 0x180F (0x2A19).

constexpr uint8_t TELEMETRY_DEFAULT_HZ = 5;  // 1..20 Hz, réglable par l'app

// ------------------------------------------------------------
// Persistance (NVS)
// ------------------------------------------------------------
#define NVS_NAMESPACE "capiq"

// ------------------------------------------------------------
// Aides angulaires (partagées par tous les modules)
// ------------------------------------------------------------
inline float normalize360(float deg) {
  deg = fmodf(deg, 360.0f);
  return (deg < 0.0f) ? deg + 360.0f : deg;
}

// Ramène un angle dans [-180, +180[.
// CONVENTION CAPIQ : erreur = wrap180(cible - cap).
//   erreur > 0 → tourner à DROITE (LED côté droit)
//   erreur < 0 → tourner à GAUCHE (LED côté gauche)
inline float wrap180(float deg) {
  deg = fmodf(deg + 180.0f, 360.0f);
  if (deg < 0.0f) deg += 360.0f;
  return deg - 180.0f;
}
