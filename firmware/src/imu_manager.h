#pragma once
#include <Arduino.h>

// ============================================================
// IMUManager — abstraction de la centrale inertielle
//
// L'interface publique n'expose QUE des degrés, des bool et des
// float : aucun type de la librairie MPU-9250 ne fuit ici.
// Pour passer au BNO085 (cible "version finale" de la BOM) :
// réécrire uniquement imu_manager.cpp avec la lib SH2/BNO08x,
// le reste de l'application ne change pas.
//
// ------------------------------------------------------------
// LIMITES CONNUES DU MPU-9250 (à lire avant usage terrain)
// ------------------------------------------------------------
// 1. Composant en fin de vie (EOL InvenSense). Beaucoup de modules
//    "GY-9250" vendus aujourd'hui contiennent en réalité un MPU-6500
//    (sans magnétomètre AK8963) ou un clone. Symptômes : begin() échoue,
//    ou hasMagnetometer() == false → le cap dérive lentement (gyro seul).
// 2. Pas de fusion embarquée : le filtre Madgwick tourne sur l'ESP32.
//    Précision de cap typique ±2-5° après une BONNE calibration mag ;
//    bien pire près de métal ou de courants forts.
// 3. Magnétomètre très sensible aux perturbations : fils d'alimentation
//    de la bande LED, batterie, véhicule, scie mécanique... Monter l'IMU
//    à distance des fils de puissance. La calibration (hard/soft iron)
//    n'est valable que pour UN montage donné : la refaire si le matériel
//    bouge sur la casquette.
// 4. Convergence : compter 5-10 s après la mise sous tension avant
//    d'obtenir un cap stable.
// 5. Inclinaison : compensée par la fusion, mais au-delà de ~±60° de
//    pitch le cap devient peu fiable.
// ============================================================
class IMUManager {
public:
  // Initialise I2C + MPU-9250 + filtre, puis charge la calibration NVS.
  // Retourne false si l'IMU ne répond pas (câblage, adresse, clone).
  bool begin();

  // À appeler le plus souvent possible dans loop() (cible >= 100 Hz).
  // Ne fait rien si aucune nouvelle donnée n'est disponible.
  void update();

  float getHeading() const;   // cap 0..360° (lissé, offset + déclinaison appliqués)
  float getPitch() const;     // degrés
  float getRoll() const;      // degrés

  bool  isHealthy() const;        // IMU détectée et fonctionnelle
  bool  hasMagnetometer() const;  // AK8963 détecté (faux sur clones MPU-6500)
  bool  isCalibrated() const;     // calibration chargée ou effectuée
  float getMeasuredRateHz() const; // fréquence réelle mesurée (échantillons/s)

  // Offset de montage (correction fixe ajoutée au cap), réglable par l'app.
  void  setHeadingOffset(float deg);
  float getHeadingOffset() const;

  // Calibration gyroscope + accéléromètre.
  // BLOQUANT ~5 s. L'appareil doit rester IMMOBILE ET À PLAT.
  // Sauvegarde automatiquement les offsets en NVS.
  bool calibrateGyroAccel();

  // Calibration magnétomètre (hard iron + soft iron).
  // BLOQUANT ~15-20 s. Décrire des "8" dans tous les axes.
  // Sauvegarde automatiquement en NVS.
  bool calibrateMag();

  // Efface la calibration sauvegardée (prend effet au redémarrage).
  void clearCalibration();

private:
  bool loadCalibration();
  bool saveCalibration();

  float heading_ = 0.0f;
  float pitch_   = 0.0f;
  float roll_    = 0.0f;
  float headingOffset_ = 0.0f;

  // Lissage EMA circulaire (composantes sin/cos pour gérer le passage 359→0)
  float emaSin_ = 0.0f;
  float emaCos_ = 1.0f;

  bool healthy_    = false;
  bool magOk_      = false;
  bool calGyroOk_  = false;
  bool calMagOk_   = false;

  uint32_t sampleCount_     = 0;
  uint32_t rateWindowStart_ = 0;
  float    measuredRateHz_  = 0.0f;
};
