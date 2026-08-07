#pragma once
#include <Arduino.h>
#include "config.h"  // IMU_INVERT_HEADING_DEFAULT (valeur initiale du signe)

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
// Pilote réellement utilisé, choisi automatiquement au démarrage.
enum class ImuBackend : uint8_t {
  NONE,            // aucun capteur exploitable
  MPU9250_FUSION,  // MPU-9250 + AK8963 : cap ABSOLU (magnétique)
  MPU6500_GYRO,    // MPU-6500 sans boussole : cap RELATIF, dérive
};

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

  // Sens de rotation du cap.
  // preserveHeading = true (changement à chaud) : l'offset est recalculé pour
  //   que le cap AFFICHÉ ne bouge pas, seul son sens de variation change.
  // preserveHeading = false (application des réglages au démarrage) : le signe
  //   est posé tel quel, sans toucher à l'offset chargé depuis la mémoire.
  void setHeadingInverted(bool inverted, bool preserveHeading = true);
  bool isHeadingInverted() const;

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

  // ---- Diagnostic matériel -------------------------------------------
  // Balaye le bus I2C et journalise chaque adresse qui répond.
  // Renvoie le nombre de périphériques trouvés. Utilisable à chaud.
  int scanBus();

  // Adresse I2C réellement utilisée (0x68 ou 0x69), 0 si aucune.
  uint8_t getAddress() const;

  // Résumé lisible de l'état matériel, remonté à l'app par le BLE.
  // Ex. « OK 0x68 » / « Aucun peripherique I2C » / « MPU 0x68 sans magnetometre »
  const char* getDiagnostic() const;

  ImuBackend getBackend() const;

  // true si le cap est ABSOLU (boussole). false = cap relatif qui dérive :
  // l'app doit alors prévenir l'utilisateur et proposer un recalage.
  bool hasAbsoluteHeading() const;

  // Recale le cap courant sur la valeur donnée (par défaut le nord).
  // Indispensable en mode gyroscope seul : on s'oriente à la boussole de
  // poche, puis on déclare « je regarde vers X degrés ».
  void alignHeadingTo(float deg);

private:
  bool loadCalibration();
  bool saveCalibration();

  float heading_ = 0.0f;
  float pitch_   = 0.0f;
  float roll_    = 0.0f;
  float headingOffset_ = 0.0f;
  // Angle brut du capteur AVANT application du signe et de l'offset.
  // Conservé pour pouvoir recalculer l'offset quand le sens s'inverse.
  float rawYaw_  = 0.0f;
  float yawSign_ = IMU_INVERT_HEADING_DEFAULT ? -1.0f : +1.0f;

  // Lissage EMA circulaire (composantes sin/cos pour gérer le passage 359→0)
  float emaSin_ = 0.0f;
  float emaCos_ = 1.0f;

  bool healthy_    = false;
  bool magOk_      = false;
  bool calGyroOk_  = false;
  bool calMagOk_   = false;

  uint8_t    address_ = 0;              // adresse I2C retenue (0 = aucune)
  char       diagnostic_[64] = "non initialise";
  ImuBackend backend_ = ImuBackend::NONE;

  // ---- État propre au pilote MPU-6500 (mode gyroscope seul) ----
  bool     initMpu6500();
  bool     updateMpu6500();   // true si un NOUVEL échantillon a été traité
  float    yawRelative_   = 0.0f;   // intégration du gyro Z, non bornée
  float    gyroBias_[3]   = {0, 0, 0};
  uint32_t lastMicros_    = 0;

  uint32_t sampleCount_     = 0;
  uint32_t rateWindowStart_ = 0;
  float    measuredRateHz_  = 0.0f;
};
