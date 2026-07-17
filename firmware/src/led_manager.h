#pragma once
#include <Arduino.h>

// ============================================================
// LEDManager — bande SK6812 RGBW comme indicateur directionnel
//
// La bande est montée horizontalement sur le devant de la casquette,
// LED centrale alignée avec l'axe du nez.
//
// Mapping direction (convention Capiq, voir config.h) :
//   erreur = cible - cap, dans [-180, +180[
//   erreur > 0 → tourner à DROITE → LED côté droit s'allument
//   erreur < 0 → tourner à GAUCHE → LED côté gauche s'allument
//   |erreur| <= zone morte → LED centrale VERTE (aligné)
//   ±DIRECTION_FULLSCALE_DEG couvre la demi-bande ; au-delà, la LED
//   d'extrémité clignote (cible derrière soi).
//   Couleur : vert (proche) → jaune → rouge (loin).
//
// Rendu : une tâche FreeRTOS dédiée dessine à 30 Hz. Avantage : les
// animations (ex. spinner de calibration) continuent même quand loop()
// est bloqué par une calibration IMU. Tous les setters sont thread-safe.
// ============================================================

enum class LedMode : uint8_t {
  BOOT,         // balayage vert au démarrage
  CONNECTION,   // respiration blanche : en attente de configuration/connexion
  DIRECTION,    // guidage directionnel normal
  CALIBRATION,  // point bleu tournant : calibration en cours
  ERROR         // clignotement rouge : IMU absente ou défaillante
};

const char* ledModeName(LedMode m);

class LEDManager {
public:
  // Initialise la bande et démarre la tâche de rendu.
  bool begin();

  void    setMode(LedMode m);
  LedMode getMode() const;

  // Erreur directionnelle courante (degrés). hasTarget=false → rien à guider.
  void setDirectionError(float errorDeg, bool hasTarget);

  // Zone morte "aligné" (± degrés), réglable par l'app.
  void  setDeadzone(float deg);
  float getDeadzone() const;

  // Luminosité 0-100 %, plafonnée en interne par LED_MAX_BRIGHTNESS
  // (budget de courant USB — voir config.h).
  void    setBrightnessPercent(uint8_t pct);
  uint8_t getBrightnessPercent() const;

  // Flash de toute la bande pendant `ms` (accusé de réception visuel :
  // cible reçue, connexion, fin de calibration...).
  void flash(uint8_t r, uint8_t g, uint8_t b, uint8_t w, uint16_t ms);

private:
  static void taskEntry(void* self);
  void renderLoop();
  void render(uint32_t frame);
  void renderBoot(uint32_t frame);
  void renderConnection(uint32_t frame);
  void renderDirection(uint32_t frame);
  void renderCalibration(uint32_t frame);
  void renderError(uint32_t frame);

  // Écrit un pixel en appliquant l'échelle de luminosité globale.
  void setPix(int idx, uint8_t r, uint8_t g, uint8_t b, uint8_t w, float intensity = 1.0f);
  int  physicalIndex(int logicalIdx) const;  // gère LED_REVERSED

  // État partagé (main/BLE → tâche de rendu), protégé par mux_
  mutable portMUX_TYPE mux_ = portMUX_INITIALIZER_UNLOCKED;
  LedMode  mode_          = LedMode::BOOT;
  float    error_         = 0.0f;
  bool     hasTarget_     = false;
  float    deadzone_      = 2.0f;
  uint8_t  brightnessPct_ = 60;
  uint8_t  flashR_ = 0, flashG_ = 0, flashB_ = 0, flashW_ = 0;
  uint32_t flashUntilMs_  = 0;

  TaskHandle_t taskHandle_ = nullptr;
};
