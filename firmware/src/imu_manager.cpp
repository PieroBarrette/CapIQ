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

bool IMUManager::begin() {
  Wire.begin(PIN_I2C_SDA, PIN_I2C_SCL);
  Wire.setClock(I2C_CLOCK_HZ);

  MPU9250Setting setting;
  setting.accel_fs_sel     = ACCEL_FS_SEL::A4G;        // mouvements de tête : ±4 g suffisent
  setting.gyro_fs_sel      = GYRO_FS_SEL::G500DPS;
  setting.mag_output_bits  = MAG_OUTPUT_BITS::M16BITS;
  setting.fifo_sample_rate = FIFO_SAMPLE_RATE::SMPL_200HZ;
  setting.gyro_dlpf_cfg    = GYRO_DLPF_CFG::DLPF_41HZ;  // filtre passe-bas matériel
  setting.accel_dlpf_cfg   = ACCEL_DLPF_CFG::DLPF_45HZ;

  mpu.verbose(false);
  if (!mpu.setup(IMU_I2C_ADDR, setting, Wire)) {
    healthy_ = false;
    Serial.println(F("[IMU] ECHEC init MPU-9250 : verifier cablage/adresse (ou module clone)"));
    return false;
  }

  magOk_ = mpu.isConnectedAK8963();
  if (!magOk_) {
    // Cas classique des clones "GY-9250" à base de MPU-6500 : pas de boussole.
    Serial.println(F("[IMU] AVERTISSEMENT : magnetometre AK8963 absent — cap au gyro seul (derive)"));
  }

  mpu.selectFilter(QuatFilterSel::MADGWICK);
  mpu.setFilterIterations(10);  // convergence/stabilité vs CPU (OK à 240 MHz)

  loadCalibration();
  healthy_ = true;
  rateWindowStart_ = millis();
  Serial.printf("[IMU] MPU-9250 OK (mag:%d, cal:%d)\n", magOk_, isCalibrated());
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
