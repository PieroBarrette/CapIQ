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
    healthy_ = false;
    // setup() échoue en bloc si l'AK8963 manque, MÊME quand la partie
    // gyroscope/accéléromètre répond correctement : on distingue les deux.
    if (!hasMagChip) {
      snprintf(diagnostic_, sizeof(diagnostic_), "MPU 0x%02X sans magnetometre", address_);
      Serial.println(F("[IMU] ECHEC : partie inertielle OK mais magnetometre AK8963 absent."));
      Serial.println(F("[IMU] La librairie exige le magnetometre. Module clone a remplacer"));
      Serial.println(F("[IMU] (un vrai MPU-9250, ou le BNO085 prevu pour la version finale)."));
    } else {
      snprintf(diagnostic_, sizeof(diagnostic_), "Init MPU 0x%02X refusee", address_);
      Serial.println(F("[IMU] ECHEC init : WHO_AM_I inattendu (clone ?) ou bus instable."));
      Serial.println(F("[IMU] Essayer un cable I2C plus court, ou I2C_CLOCK_HZ = 100000."));
    }
    return false;
  }

  magOk_ = mpu.isConnectedAK8963();
  snprintf(diagnostic_, sizeof(diagnostic_), "OK 0x%02X%s", address_,
           magOk_ ? "" : " (sans magnetometre)");

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

void  IMUManager::setHeadingOffset(float deg) { headingOffset_ = deg; }
float IMUManager::getHeadingOffset() const    { return headingOffset_; }

bool IMUManager::calibrateGyroAccel() {
  if (!healthy_) return false;
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
