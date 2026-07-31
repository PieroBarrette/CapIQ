#include "led_manager.h"
#include "config.h"
#include <Adafruit_NeoPixel.h>

// NEO_GRBW : ordre standard des BTF-LIGHTING SK6812 RGBW.
// Si les couleurs sont permutées sur votre lot, essayer NEO_RGBW.
namespace {
Adafruit_NeoPixel strip(LED_COUNT, PIN_LED_DATA, NEO_GRBW + NEO_KHZ800);
}

const char* ledModeName(LedMode m) {
  switch (m) {
    case LedMode::BOOT:        return "BOOT";
    case LedMode::CONNECTION:  return "CONNECTION";
    case LedMode::DIRECTION:   return "DIRECTION";
    case LedMode::CALIBRATION: return "CALIBRATION";
    case LedMode::ERROR:       return "ERROR";
  }
  return "?";
}

bool LEDManager::begin() {
  strip.begin();
  strip.clear();
  strip.show();
  // Tâche de rendu sur le cœur 1 (le BLE vit sur le cœur 0).
  const BaseType_t ok = xTaskCreatePinnedToCore(
      taskEntry, "capiq_led", 4096, this, 1, &taskHandle_, 1);
  return ok == pdPASS;
}

void LEDManager::taskEntry(void* self) {
  static_cast<LEDManager*>(self)->renderLoop();
}

void LEDManager::renderLoop() {
  uint32_t frame = 0;
  const TickType_t period = pdMS_TO_TICKS(1000 / LED_FRAME_HZ);
  TickType_t lastWake = xTaskGetTickCount();
  for (;;) {
    render(frame++);
    strip.show();
    vTaskDelayUntil(&lastWake, period);
  }
}

void LEDManager::render(uint32_t frame) {
  strip.clear();

  // Copie locale de l'état partagé (section critique la plus courte possible)
  portENTER_CRITICAL(&mux_);
  const LedMode  mode      = mode_;
  const float    error     = error_;
  const bool     hasTarget = hasTarget_;
  const float    deadzone  = deadzone_;
  const uint32_t flashUntil = flashUntilMs_;
  const uint8_t  fr = flashR_, fg = flashG_, fb = flashB_, fw = flashW_;
  portEXIT_CRITICAL(&mux_);

  // Flash prioritaire (accusé de réception)
  if (millis() < flashUntil) {
    setPix((int)LED_CENTER_INDEX, fr, fg, fb, fw, 0.6f);
    return;
  }

  switch (mode) {
    case LedMode::BOOT:        renderBoot(frame); break;
    case LedMode::CONNECTION:  renderConnection(frame); break;
    case LedMode::CALIBRATION: renderCalibration(frame); break;
    case LedMode::ERROR:       renderError(frame); break;
    case LedMode::DIRECTION:
      if (hasTarget) {
        // deadzone/error consommés par renderDirection via les copies locales :
        // on repasse par les membres pour garder une signature simple.
        (void)deadzone; (void)error;
        renderDirection(frame);
      } else {
        renderConnection(frame);
      }
      break;
  }
}

// ---- Rendus par mode -------------------------------------------------

void LEDManager::renderBoot(uint32_t frame) {
  // Un seul point vert en balayage.
  const int idx = (frame / 2) % LED_COUNT;
  setPix(idx, 0, 180, 30, 0, 0.5f);
}

void LEDManager::renderConnection(uint32_t frame) {
  // Respiration blanche sur la LED centrale uniquement.
  const float breath = (sinf(frame * 0.08f) + 1.0f) * 0.5f;  // 0..1
  const float inten = 0.15f + 0.85f * breath;
  setPix((int)LED_CENTER_INDEX, 0, 0, 40, 160, inten);
}

void LEDManager::renderDirection(uint32_t frame) {
  portENTER_CRITICAL(&mux_);
  const float error    = error_;
  const float deadzone = deadzone_;
  portEXIT_CRITICAL(&mux_);

  const int center = (int)LED_CENTER_INDEX;

  if (fabsf(error) <= deadzone) {
    // ALIGNÉ : centre vert en respiration douce.
    const float breath = 0.35f + 0.25f * (sinf(frame * 0.15f) + 1.0f) * 0.5f;
    setPix(center, 0, 255, 40, 0, breath);
    return;
  }

  // Couleur selon l'amplitude : vert → jaune → rouge
  const float t = min(fabsf(error) / DIRECTION_FULLSCALE_DEG, 1.0f);
  const uint8_t r = (uint8_t)min(510.0f * t, 255.0f);
  const uint8_t g = (uint8_t)min(510.0f * (1.0f - t), 255.0f);

  if (fabsf(error) > DIRECTION_FULLSCALE_DEG) {
    // Cible au-delà de ±90° (voire derrière) : LED d'extrémité clignotante
    const int edge = (error > 0) ? LED_COUNT - 1 : 0;
    if ((frame >> 3) & 1) setPix(edge, 255, 0, 0, 0);
    return;
  }

  // Position quantifiée : un seul pixel allumé selon l'erreur.
  const float halfSpan = (float)max(1, center);
  float pos = center + (error / DIRECTION_FULLSCALE_DEG) * halfSpan;
  pos = constrain(pos, 0.0f, (float)(LED_COUNT - 1));
  const int idx = (int)roundf(pos);
  setPix(idx, r, g, 0, 0);
}

void LEDManager::renderCalibration(uint32_t frame) {
  // Point bleu tournant unique : "bougez la tête en 8".
  const int idx = (frame / 2) % LED_COUNT;
  setPix(idx, 0, 60, 255, 0);
}

void LEDManager::renderError(uint32_t frame) {
  // Clignotement rouge 1 Hz sur la LED centrale uniquement.
  if ((frame % (LED_FRAME_HZ)) < (LED_FRAME_HZ / 2)) {
    setPix((int)LED_CENTER_INDEX, 160, 0, 0, 0);
  }
}

// ---- Aides -----------------------------------------------------------

int LEDManager::physicalIndex(int logicalIdx) const {
  return LED_REVERSED ? (LED_COUNT - 1 - logicalIdx) : logicalIdx;
}

void LEDManager::setPix(int idx, uint8_t r, uint8_t g, uint8_t b, uint8_t w, float intensity) {
  if (idx < 0 || idx >= (int)LED_COUNT) return;
  portENTER_CRITICAL(&mux_);
  const uint8_t pct = brightnessPct_;
  portEXIT_CRITICAL(&mux_);
  // Échelle globale : % utilisateur × plafond matériel (voir config.h).
  // Appliquée par pixel plutôt que via strip.setBrightness() (destructif).
  const float scale = intensity * (pct / 100.0f) * (LED_MAX_BRIGHTNESS / 255.0f);
  strip.setPixelColor(physicalIndex(idx),
                      Adafruit_NeoPixel::Color((uint8_t)(r * scale), (uint8_t)(g * scale),
                                               (uint8_t)(b * scale), (uint8_t)(w * scale)));
}

// ---- Setters thread-safe ---------------------------------------------

void LEDManager::setMode(LedMode m) {
  portENTER_CRITICAL(&mux_);
  mode_ = m;
  portEXIT_CRITICAL(&mux_);
}

LedMode LEDManager::getMode() const {
  portENTER_CRITICAL(&mux_);
  const LedMode m = mode_;
  portEXIT_CRITICAL(&mux_);
  return m;
}

void LEDManager::setDirectionError(float errorDeg, bool hasTarget) {
  portENTER_CRITICAL(&mux_);
  error_ = errorDeg;
  hasTarget_ = hasTarget;
  portEXIT_CRITICAL(&mux_);
}

void LEDManager::setDeadzone(float deg) {
  portENTER_CRITICAL(&mux_);
  deadzone_ = max(0.0f, deg);
  portEXIT_CRITICAL(&mux_);
}

float LEDManager::getDeadzone() const {
  portENTER_CRITICAL(&mux_);
  const float d = deadzone_;
  portEXIT_CRITICAL(&mux_);
  return d;
}

void LEDManager::setBrightnessPercent(uint8_t pct) {
  portENTER_CRITICAL(&mux_);
  brightnessPct_ = min<uint8_t>(pct, 100);
  portEXIT_CRITICAL(&mux_);
}

uint8_t LEDManager::getBrightnessPercent() const {
  portENTER_CRITICAL(&mux_);
  const uint8_t p = brightnessPct_;
  portEXIT_CRITICAL(&mux_);
  return p;
}

void LEDManager::flash(uint8_t r, uint8_t g, uint8_t b, uint8_t w, uint16_t ms) {
  portENTER_CRITICAL(&mux_);
  flashR_ = r; flashG_ = g; flashB_ = b; flashW_ = w;
  flashUntilMs_ = millis() + ms;
  portEXIT_CRITICAL(&mux_);
}
