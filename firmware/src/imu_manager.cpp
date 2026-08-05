#include "imu_manager.h"
#include "config.h"
#include <Wire.h>
#include <Preferences.h>
#include "MPU9250.h"  // hideakitai/MPU9250 (inclut la fusion Madgwick)

// Instance unique de la lib, confinée à ce fichier pour que l'interface
// publique reste indépendante du capteur (remplacement BNO085 futur).
namespace {
MPU9250 mpu;
constexpr uint16_t CAL_VERSION = 1;  // invalide les vieilles calibrations si le format change
}

// Interroge une adresse I2C : true si un composant acquitte.
static bool i2cPing(uint8_t addr) {
  Wire.beginTransmission(addr);
  return Wire.endTransmission() == 0;
}

// ============================================================
// Pilote minimal MPU-6500 (mode dégradé, sans magnétomètre)
//
// Pourquoi ce code existe : beaucoup de modules vendus « GY-9250 »
// embarquent en réalité un MPU-6500 (WHO_AM_I = 0x70), dépourvu de
// boussole. La librairie hideakitai/MPU9250 refuse alors d'initialiser
// EN BLOC, même si la partie inertielle fonctionne parfaitement.
// Ces quelques registres permettent d'exploiter quand même le capteur
// pour valider toute la chaîne (LED, BLE, PWA) en attendant un capteur
// à magnétomètre.
//
// LIMITE FONDAMENTALE : le cap obtenu est RELATIF. Il provient de
// l'intégration du gyroscope Z et dérive de quelques degrés par minute.
// Utilisable au banc, PAS pour naviguer en forêt.
// ============================================================
namespace mpu6500 {

constexpr uint8_t REG_SMPLRT_DIV   = 0x19;
constexpr uint8_t REG_CONFIG       = 0x1A;
constexpr uint8_t REG_GYRO_CONFIG  = 0x1B;
constexpr uint8_t REG_ACCEL_CONFIG = 0x1C;
constexpr uint8_t REG_ACCEL_CONF2  = 0x1D;
constexpr uint8_t REG_INT_STATUS   = 0x3A;
constexpr uint8_t REG_ACCEL_XOUT_H = 0x3B;
constexpr uint8_t REG_PWR_MGMT_1   = 0x6B;
constexpr uint8_t REG_WHO_AM_I     = 0x75;

// ±4 g et ±500 °/s : mêmes plages que la configuration 9 axes.
constexpr float ACCEL_LSB_PER_G   = 8192.0f;
constexpr float GYRO_LSB_PER_DPS  = 65.5f;

void writeReg(uint8_t addr, uint8_t reg, uint8_t value) {
  Wire.beginTransmission(addr);
  Wire.write(reg);
  Wire.write(value);
  Wire.endTransmission();
}

uint8_t readReg(uint8_t addr, uint8_t reg) {
  Wire.beginTransmission(addr);
  Wire.write(reg);
  if (Wire.endTransmission(false) != 0) return 0;
  if (Wire.requestFrom((int)addr, 1) != 1) return 0;
  return Wire.read();
}

// Lit les 14 octets accel + temp + gyro d'un seul bloc.
bool readMotion(uint8_t addr, float acc[3], float gyr[3]) {
  Wire.beginTransmission(addr);
  Wire.write(REG_ACCEL_XOUT_H);
  if (Wire.endTransmission(false) != 0) return false;
  if (Wire.requestFrom((int)addr, 14) != 14) return false;

  int16_t raw[7];
  for (int i = 0; i < 7; i++) {
    const uint8_t hi = Wire.read();
    const uint8_t lo = Wire.read();
    raw[i] = (int16_t)((hi << 8) | lo);
  }
  for (int i = 0; i < 3; i++) acc[i] = raw[i]     / ACCEL_LSB_PER_G;
  for (int i = 0; i < 3; i++) gyr[i] = raw[4 + i] / GYRO_LSB_PER_DPS;
  return true;
}

}  // namespace mpu6500

bool IMUManager::initMpu6500() {
  using namespace mpu6500;
  writeReg(address_, REG_PWR_MGMT_1, 0x80);  // reset complet
  delay(100);
  writeReg(address_, REG_PWR_MGMT_1, 0x01);  // réveil, horloge sur le gyro X
  delay(20);
  writeReg(address_, REG_CONFIG,       0x03);  // DLPF gyro 41 Hz
  writeReg(address_, REG_GYRO_CONFIG,  0x08);  // ±500 °/s
  writeReg(address_, REG_ACCEL_CONFIG, 0x08);  // ±4 g
  writeReg(address_, REG_ACCEL_CONF2,  0x03);  // DLPF accel 41 Hz
  writeReg(address_, REG_SMPLRT_DIV,   0x04);  // 1 kHz / 5 = 200 Hz
  delay(20);

  float acc[3], gyr[3];
  if (!readMotion(address_, acc, gyr)) {
    Serial.println(F("[IMU] MPU-6500 : lecture des donnees impossible."));
    return false;
  }
  lastMicros_ = micros();
  return true;
}

bool IMUManager::updateMpu6500() {
  using namespace mpu6500;
  // Attendre la donnée fraîche (bit RAW_DATA_RDY) : sans ce garde-fou on
  // relit le même échantillon ~8 fois, ce qui sature le bus I2C pour rien.
  if ((readReg(address_, REG_INT_STATUS) & 0x01) == 0) return false;

  float acc[3], gyr[3];
  if (!readMotion(address_, acc, gyr)) return false;

  const uint32_t now = micros();
  float dt = (now - lastMicros_) * 1e-6f;
  lastMicros_ = now;
  if (dt <= 0.0f || dt > 0.5f) return false;  // premier tour ou hoquet : on saute

  // Biais retiré (mesuré par la calibration, capteur immobile)
  const float gx = gyr[0] - gyroBias_[0];
  const float gy = gyr[1] - gyroBias_[1];
  const float gz = gyr[2] - gyroBias_[2];

  // Pitch/roll : l'accéléromètre donne une référence absolue (la gravité),
  // le gyro donne la réactivité. Filtre complémentaire classique.
  const float accRoll  = atan2f(acc[1], acc[2]) * RAD_TO_DEG;
  const float accPitch = atan2f(-acc[0], sqrtf(acc[1] * acc[1] + acc[2] * acc[2])) * RAD_TO_DEG;
  constexpr float ALPHA = 0.98f;
  roll_  = ALPHA * (roll_  + gx * dt) + (1.0f - ALPHA) * accRoll;
  pitch_ = ALPHA * (pitch_ + gy * dt) + (1.0f - ALPHA) * accPitch;

  // Yaw : PURE intégration du gyro — aucune référence absolue, donc dérive.
  yawRelative_ += gz * dt;

  const float h = normalize360(IMU_YAW_SIGN * yawRelative_ + headingOffset_);
  const float r = h * DEG_TO_RAD;
  emaSin_ += HEADING_SMOOTHING_ALPHA * (sinf(r) - emaSin_);
  emaCos_ += HEADING_SMOOTHING_ALPHA * (cosf(r) - emaCos_);
  heading_ = normalize360(atan2f(emaSin_, emaCos_) * RAD_TO_DEG);
  return true;
}

int IMUManager::scanBus() {
  Serial.println(F("[I2C] Balayage du bus..."));
  int found = 0;
  for (uint8_t addr = 1; addr < 127; addr++) {
    if (!i2cPing(addr)) continue;
    found++;
    const char* known = "";
    if (addr == 0x68) known = "  <- MPU-9250/6500 (AD0 a la masse)";
    else if (addr == 0x69) known = "  <- MPU-9250/6500 (AD0 a 3.3 V)";
    else if (addr == 0x0C) known = "  <- AK8963 (magnetometre du MPU-9250)";
    else if (addr == 0x0D) known = "  <- QMC5883L (module clone : magnetometre incompatible)";
    else if (addr == 0x1E) known = "  <- HMC5883L (magnetometre externe)";
    Serial.printf("[I2C]   0x%02X%s\n", addr, known);
  }
  if (found == 0) {
    Serial.println(F("[I2C] AUCUN peripherique detecte."));
    Serial.printf("[I2C] Verifier : SDA=GPIO%d, SCL=GPIO%d, VCC=3V3, GND commun,\n",
                  PIN_I2C_SDA, PIN_I2C_SCL);
    Serial.println(F("[I2C] soudures du module, et cable I2C court."));
  } else {
    Serial.printf("[I2C] %d peripherique(s) trouve(s).\n", found);
  }
  return found;
}

bool IMUManager::begin() {
  Wire.begin(PIN_I2C_SDA, PIN_I2C_SCL);
  Wire.setClock(I2C_CLOCK_HZ);

  // Photographie du bus AVANT toute tentative : c'est ce balayage qui
  // distingue un probleme de cablage, une mauvaise adresse (AD0) et un
  // module clone depourvu de magnetometre AK8963.
  const int devices = scanBus();
  const bool has68 = i2cPing(0x68);
  const bool has69 = i2cPing(0x69);
  const bool hasMagChip = i2cPing(0x0C);

  if (devices == 0) {
    healthy_ = false;
    snprintf(diagnostic_, sizeof(diagnostic_), "Aucun peripherique I2C (cablage ?)");
    Serial.println(F("[IMU] ECHEC : rien sur le bus I2C."));
    return false;
  }

  // AD0 a la masse (0x68) par defaut, sinon AD0 a 3.3 V (0x69).
  address_ = has68 ? 0x68 : (has69 ? 0x69 : 0);
  if (address_ == 0) {
    healthy_ = false;
    snprintf(diagnostic_, sizeof(diagnostic_), "MPU absent (ni 0x68 ni 0x69)");
    Serial.println(F("[IMU] ECHEC : aucun MPU a 0x68 ni 0x69 (voir balayage ci-dessus)."));
    return false;
  }
  if (address_ != IMU_I2C_ADDR) {
    Serial.printf("[IMU] Adresse detectee 0x%02X (config.h indique 0x%02X) — "
                  "detection automatique utilisee.\n", address_, IMU_I2C_ADDR);
  }
  if (!hasMagChip) {
    // La librairie refuse de demarrer sans AK8963 : on previent explicitement.
    Serial.println(F("[IMU] ATTENTION : aucun magnetometre a 0x0C."));
    Serial.println(F("[IMU] Module 'GY-9250' clone a base de MPU-6500 ? Voir docs/HARDWARE.md."));
  }

  MPU9250Setting setting;
  setting.accel_fs_sel     = ACCEL_FS_SEL::A4G;        // mouvements de tête : ±4 g suffisent
  setting.gyro_fs_sel      = GYRO_FS_SEL::G500DPS;
  setting.mag_output_bits  = MAG_OUTPUT_BITS::M16BITS;
  setting.fifo_sample_rate = FIFO_SAMPLE_RATE::SMPL_200HZ;
  setting.gyro_dlpf_cfg    = GYRO_DLPF_CFG::DLPF_41HZ;  // filtre passe-bas matériel
  setting.accel_dlpf_cfg   = ACCEL_DLPF_CFG::DLPF_45HZ;

  // verbose(true) pendant setup() : sans cela, les messages de la librairie
  // (« Could not connect to MPU9250 / AK8963 ») sont avalés et l'on se
  // retrouve en mode ERREUR sans la moindre explication.
  mpu.verbose(true);
  const bool ok = mpu.setup(address_, setting, Wire);
  mpu.verbose(false);

  if (!ok) {
    // setup() échoue en bloc si l'AK8963 manque, MÊME quand la partie
    // gyroscope/accéléromètre répond correctement : on distingue les deux.
    if (!hasMagChip) {
      // MODE DÉGRADÉ : on pilote le MPU-6500 nous-mêmes. Le cap devient
      // relatif (dérive), mais toute la chaîne LED/BLE/PWA reste testable.
      const uint8_t who = mpu6500::readReg(address_, mpu6500::REG_WHO_AM_I);
      Serial.printf("[IMU] Magnetometre absent (WHO_AM_I = 0x%02X : %s).\n", who,
                    who == 0x70 ? "MPU-6500, 6 axes" : "puce non identifiee");
      if (initMpu6500()) {
        backend_ = ImuBackend::MPU6500_GYRO;
        healthy_ = true;
        magOk_   = false;
        snprintf(diagnostic_, sizeof(diagnostic_),
                 "MPU-6500 0x%02X : cap RELATIF (derive)", address_);
        loadCalibration();
        rateWindowStart_ = millis();
        Serial.println(F("[IMU] MODE DEGRADE actif : gyroscope seul."));
        Serial.println(F("[IMU] Le cap DERIVE de quelques degres par minute et n'est PAS"));
        Serial.println(F("[IMU] un azimut absolu. Recaler avec 'z <deg>' (boussole de poche)."));
        Serial.println(F("[IMU] Pour un vrai cap : capteur avec magnetometre (BNO085 de la BOM)."));
        return true;
      }
      healthy_ = false;
      snprintf(diagnostic_, sizeof(diagnostic_), "MPU 0x%02X illisible", address_);
      Serial.println(F("[IMU] ECHEC : mode degrade impossible, capteur muet."));
    } else {
      healthy_ = false;
      snprintf(diagnostic_, sizeof(diagnostic_), "Init MPU 0x%02X refusee", address_);
      Serial.println(F("[IMU] ECHEC init : WHO_AM_I inattendu (clone ?) ou bus instable."));
      Serial.println(F("[IMU] Essayer un cable I2C plus court, ou I2C_CLOCK_HZ = 100000."));
    }
    return false;
  }

  magOk_   = mpu.isConnectedAK8963();
  backend_ = ImuBackend::MPU9250_FUSION;
  snprintf(diagnostic_, sizeof(diagnostic_), "MPU-9250 0x%02X : cap absolu", address_);

  mpu.selectFilter(QuatFilterSel::MADGWICK);
  mpu.setFilterIterations(10);  // convergence/stabilité vs CPU (OK à 240 MHz)

  loadCalibration();
  healthy_ = true;
  rateWindowStart_ = millis();
  Serial.printf("[IMU] MPU-9250 initialise sur 0x%02X (magnetometre:%d, calibre:%d)\n",
                address_, magOk_, isCalibrated());
  return true;
}

void IMUManager::update() {
  if (!healthy_) return;

  if (backend_ == ImuBackend::MPU6500_GYRO) {
    // Sans ce test, le compteur mesurerait la cadence de loop() (~4 kHz)
    // et non celle des échantillons réellement fournis par le capteur.
    if (!updateMpu6500()) return;
  } else {
    if (!mpu.update()) return;  // pas de nouvelle donnée

    // Yaw brut -180..+180 → cap 0..360 avec déclinaison + offset de montage
    const float yaw = IMU_YAW_SIGN * mpu.getYaw();
    const float h   = normalize360(yaw + MAG_DECLINATION_DEG + headingOffset_);

    // EMA circulaire : lisser sin/cos évite le saut 359.9 → 0.1
    const float r = h * DEG_TO_RAD;
    emaSin_ += HEADING_SMOOTHING_ALPHA * (sinf(r) - emaSin_);
    emaCos_ += HEADING_SMOOTHING_ALPHA * (cosf(r) - emaCos_);
    heading_ = normalize360(atan2f(emaSin_, emaCos_) * RAD_TO_DEG);

    pitch_ = mpu.getPitch();
    roll_  = mpu.getRoll();
  }

  // Mesure de la fréquence réelle sur une fenêtre d'une seconde
  sampleCount_++;
  const uint32_t now = millis();
  if (now - rateWindowStart_ >= 1000) {
    measuredRateHz_  = sampleCount_ * 1000.0f / (float)(now - rateWindowStart_);
    sampleCount_     = 0;
    rateWindowStart_ = now;
  }
}

float IMUManager::getHeading() const { return heading_; }
float IMUManager::getPitch() const   { return pitch_; }
float IMUManager::getRoll() const    { return roll_; }
bool  IMUManager::isHealthy() const       { return healthy_; }
bool  IMUManager::hasMagnetometer() const { return magOk_; }
bool  IMUManager::isCalibrated() const    { return calGyroOk_ && (calMagOk_ || !magOk_); }
float IMUManager::getMeasuredRateHz() const { return measuredRateHz_; }
uint8_t     IMUManager::getAddress() const    { return address_; }
const char* IMUManager::getDiagnostic() const { return diagnostic_; }
ImuBackend  IMUManager::getBackend() const    { return backend_; }

bool IMUManager::hasAbsoluteHeading() const {
  return backend_ == ImuBackend::MPU9250_FUSION && magOk_;
}

void IMUManager::alignHeadingTo(float deg) {
  // Décale l'offset pour que la lecture courante devienne `deg`, puis
  // réamorce le lissage sur la nouvelle valeur (sinon l'EMA ramène
  // progressivement vers l'ancien cap).
  headingOffset_ = normalize360(headingOffset_ + (deg - heading_));
  const float r = normalize360(deg) * DEG_TO_RAD;
  emaSin_  = sinf(r);
  emaCos_  = cosf(r);
  heading_ = normalize360(deg);
  Serial.printf("[IMU] Cap recale sur %.1f deg (offset = %.1f).\n", heading_, headingOffset_);
}

void  IMUManager::setHeadingOffset(float deg) { headingOffset_ = deg; }
float IMUManager::getHeadingOffset() const    { return headingOffset_; }

bool IMUManager::calibrateGyroAccel() {
  if (!healthy_) return false;

  if (backend_ == ImuBackend::MPU6500_GYRO) {
    // Moyenne du gyroscope au repos : ce biais est la principale source
    // de dérive du cap, donc l'étalonnage le plus rentable ici.
    Serial.println(F("[IMU] Calibration gyro (MPU-6500) : NE PAS BOUGER (~3 s)..."));
    double sum[3] = {0, 0, 0};
    int samples = 0;
    const uint32_t until = millis() + 3000;
    while (millis() < until) {
      float acc[3], gyr[3];
      if (mpu6500::readMotion(address_, acc, gyr)) {
        for (int i = 0; i < 3; i++) sum[i] += gyr[i];
        samples++;
      }
      delay(3);
    }
    if (samples < 100) {
      Serial.println(F("[IMU] Calibration ECHOUEE : trop peu d'echantillons."));
      return false;
    }
    for (int i = 0; i < 3; i++) gyroBias_[i] = (float)(sum[i] / samples);
    yawRelative_ = 0.0f;
    lastMicros_  = micros();
    calGyroOk_   = true;
    saveCalibration();
    Serial.printf("[IMU] Biais gyro : %.3f / %.3f / %.3f deg/s (%d echantillons)\n",
                  gyroBias_[0], gyroBias_[1], gyroBias_[2], samples);
    return true;
  }

  Serial.println(F("[IMU] Calibration gyro/accel : NE PAS BOUGER (~5 s)..."));
  mpu.verbose(true);
  mpu.calibrateAccelGyro();
  mpu.verbose(false);
  calGyroOk_ = true;
  saveCalibration();
  Serial.println(F("[IMU] Calibration gyro/accel terminee et sauvegardee."));
  return true;
}

bool IMUManager::calibrateMag() {
  if (!healthy_ || !magOk_) return false;
  Serial.println(F("[IMU] Calibration magnetometre : decrire des 8 dans tous les axes (~15-20 s)..."));
  mpu.verbose(true);
  mpu.calibrateMag();
  mpu.verbose(false);
  calMagOk_ = true;
  saveCalibration();
  Serial.println(F("[IMU] Calibration magnetometre terminee et sauvegardee."));
  return true;
}

void IMUManager::clearCalibration() {
  Preferences prefs;
  prefs.begin(NVS_NAMESPACE, false);
  prefs.remove("cal_ver");
  prefs.end();
  calGyroOk_ = false;
  calMagOk_  = false;
  Serial.println(F("[IMU] Calibration effacee (redemarrer pour repartir a zero)."));
}

bool IMUManager::loadCalibration() {
  Preferences prefs;
  prefs.begin(NVS_NAMESPACE, true);
  const bool valid = (prefs.getUShort("cal_ver", 0) == CAL_VERSION);
  if (valid) {
    calGyroOk_ = prefs.getBool("cal_ag", false);
    calMagOk_  = prefs.getBool("cal_mg", false);
    // Le mode dégradé a ses propres biais : ceux de la librairie ne sont
    // pas exploitables puisqu'elle n'est jamais initialisée dans ce cas.
    if (backend_ == ImuBackend::MPU6500_GYRO) {
      gyroBias_[0] = prefs.getFloat("d_gbx", 0);
      gyroBias_[1] = prefs.getFloat("d_gby", 0);
      gyroBias_[2] = prefs.getFloat("d_gbz", 0);
      calGyroOk_   = prefs.getBool("cal_d", false);
      prefs.end();
      return calGyroOk_;
    }
    if (calGyroOk_) {
      mpu.setAccBias(prefs.getFloat("abx", 0), prefs.getFloat("aby", 0), prefs.getFloat("abz", 0));
      mpu.setGyroBias(prefs.getFloat("gbx", 0), prefs.getFloat("gby", 0), prefs.getFloat("gbz", 0));
    }
    if (calMagOk_) {
      mpu.setMagBias(prefs.getFloat("mbx", 0), prefs.getFloat("mby", 0), prefs.getFloat("mbz", 0));
      mpu.setMagScale(prefs.getFloat("msx", 1), prefs.getFloat("msy", 1), prefs.getFloat("msz", 1));
    }
  }
  prefs.end();
  return valid && (calGyroOk_ || calMagOk_);
}

bool IMUManager::saveCalibration() {
  Preferences prefs;
  if (!prefs.begin(NVS_NAMESPACE, false)) return false;
  prefs.putUShort("cal_ver", CAL_VERSION);

  if (backend_ == ImuBackend::MPU6500_GYRO) {
    prefs.putBool("cal_d", calGyroOk_);
    prefs.putFloat("d_gbx", gyroBias_[0]);
    prefs.putFloat("d_gby", gyroBias_[1]);
    prefs.putFloat("d_gbz", gyroBias_[2]);
    prefs.end();
    return true;
  }

  prefs.putBool("cal_ag", calGyroOk_);
  prefs.putBool("cal_mg", calMagOk_);
  prefs.putFloat("abx", mpu.getAccBiasX());
  prefs.putFloat("aby", mpu.getAccBiasY());
  prefs.putFloat("abz", mpu.getAccBiasZ());
  prefs.putFloat("gbx", mpu.getGyroBiasX());
  prefs.putFloat("gby", mpu.getGyroBiasY());
  prefs.putFloat("gbz", mpu.getGyroBiasZ());
  prefs.putFloat("mbx", mpu.getMagBiasX());
  prefs.putFloat("mby", mpu.getMagBiasY());
  prefs.putFloat("mbz", mpu.getMagBiasZ());
  prefs.putFloat("msx", mpu.getMagScaleX());
  prefs.putFloat("msy", mpu.getMagScaleY());
  prefs.putFloat("msz", mpu.getMagScaleZ());
  prefs.end();
  return true;
}
