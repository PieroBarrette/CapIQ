# Capiq V0.1 — Câblage et matériel

## Nomenclature (prototype)

| Composant | Référence | Notes |
|---|---|---|
| Microcontrôleur | ESP32 DevKit (WROOM-32) | BLE intégré. ESP32-S3 supporté (env. PlatformIO dédié) |
| IMU 9 axes | MPU-9250 « GY-9250 » | 3.3 V, I2C, magnétomètre AK8963 intégré |
| Bande LED | BTF-LIGHTING SK6812 **RGBW**, 144 LED/m | 5 V, 1 fil de données, protocole type WS2812 |
| Alimentation | USB 5 V (proto) | Li-ion prévue en V0.2 (voir plus bas) |

## Tableau de branchements

| Composant | Pin ESP32 | Fonction |
|---|---|---|
| MPU-9250 VCC | 3V3 | Alimentation capteur (⚠️ jamais 5 V) |
| MPU-9250 GND | GND | Masse |
| MPU-9250 SDA | GPIO 21 | Données I2C (400 kHz) |
| MPU-9250 SCL | GPIO 22 | Horloge I2C |
| SK6812 VCC | VIN (5 V USB) | Puissance LED |
| SK6812 GND | GND | Masse **commune** avec l'ESP32 |
| SK6812 DATA | GPIO 13 → R 330 Ω → DIN | Signal de données |
| *(futur)* pont diviseur batterie | GPIO 34 | Entrée ADC (input-only, idéal) |

Sur **ESP32-S3 DevKitC-1** : SDA = GPIO 8, SCL = GPIO 9, LED = GPIO 13,
ADC batterie = GPIO 4 (appliqué automatiquement par `config.h`).

### Pourquoi ces GPIO ?
- **21/22** : I2C matériel par défaut de l'ESP32, aucun rôle au démarrage.
- **13** : sortie libre, sans fonction de strapping, compatible RMT.
- Évités : GPIO 0/2/5/12/15 (strapping — un niveau imposé au boot peut empêcher
  le démarrage), GPIO 6-11 (flash interne — **ne jamais utiliser**),
  GPIO 34-39 (entrée seule — inutilisables pour DATA LED).
- Le Bluetooth est purement interne : aucun conflit de broche possible.

## Schéma de câblage

```
                 ESP32 DevKit
                ┌─────────────┐
   USB 5V ──────┤ VIN     3V3 ├──────────► MPU-9250 VCC
                │             │
        ┌───────┤ GND   GPIO21├──────────► MPU-9250 SDA
        │       │       GPIO22├──────────► MPU-9250 SCL
        │       │             │
        │       │       GPIO13├──[330Ω]──► SK6812 DATA IN
        │       └─────────────┘
        │                                    SK6812 VCC ◄── VIN (5V)
        └── GND commun ─────────────────────► SK6812 GND
                          ┌──────┴──────┐
                          │ 1000 µF /6V+│  (condensateur tampon
                          └─────────────┘   aux bornes de la bande)
```

## Trois précautions d'intégration (importantes)

1. **Niveau logique 3.3 V → LED 5 V.** Le seuil « haut » du SK6812 est
   0,7 × VDD = 3,5 V : le 3,3 V de l'ESP32 est *en dessous de la spec*. En
   pratique ça fonctionne presque toujours avec un fil de données **court
   (< 10 cm)** et la résistance série. Si vous voyez des scintillements ou de
   fausses couleurs : ajouter un level shifter **74AHCT125** (propre), ou
   alimenter la bande à travers une **diode 1N4007** (VDD ≈ 4,4 V → le 3,3 V
   redevient dans la spec).
2. **Budget de courant.** 15 LED RGBW à blanc complet ≈ **1,2 A** — trop pour
   un port USB de PC (500 mA). Le firmware plafonne la luminosité
   (`LED_MAX_BRIGHTNESS = 160`) et le mode direction n'allume que quelques LED
   (consommation typique < 250 mA). Utiliser un chargeur USB ≥ 1 A pour les
   essais. Ne pas augmenter le plafond sans revoir l'alimentation.
3. **Condensateur + masse commune.** 1000 µF aux bornes d'alimentation de la
   bande (absorbe les appels de courant), et GND de la bande relié au GND de
   l'ESP32 (référence du signal DATA).

## Montage sur la casquette

- **Bande LED** : horizontale sur le devant de la visière, **LED n° 7 (centre)
  alignée avec l'axe du nez**. Si la bande est posée dans l'autre sens, mettre
  `LED_REVERSED = true` dans `config.h`.
- **IMU** : à plat sur la casquette, **axe X vers l'avant**. Un montage inversé
  se corrige avec `IMU_YAW_SIGN = -1`, un décalage angulaire résiduel avec le
  réglage *Offset azimut* de l'app.
- **Éloigner l'IMU des fils de puissance de la bande LED** (champ magnétique →
  fausse le magnétomètre). Idéalement IMU sur le dessus, LED devant,
  ESP32/batterie à l'arrière.
- Refaire la **calibration boussole** après tout changement mécanique.

## Dépannage : « Mode erreur capteur » (LED centrale rouge clignotante)

La LED rouge signifie que `imu.begin()` a échoué. Branchez le casque en USB,
ouvrez le moniteur série (115200) et lisez le **balayage I2C** affiché au
démarrage — ou tapez **`s`** pour le relancer à chaud.

| Ce que montre le balayage | Cause | Correctif |
|---|---|---|
| `AUCUN peripherique detecte` | Câblage, alimentation ou soudure | Vérifier VCC=3V3, GND **commun**, SDA=GPIO 21, SCL=GPIO 22 ; ressouder ; raccourcir les fils |
| `0x69` mais pas `0x68` | AD0 tiré à 3,3 V | Rien à faire : l'adresse est détectée automatiquement depuis la V0.1 |
| `0x68` **sans** `0x0C` | Module « GY-9250 » clone à base de **MPU-6500** (sans magnétomètre) | Le firmware bascule en **mode dégradé** (voir ci-dessous). Pour un vrai azimut : capteur à magnétomètre — **BNO085** de la BOM |
| `0x68` **et** `0x0C`, mais init refusée | WHO_AM_I inattendu, ou bus instable | Raccourcir les fils I2C ; passer `I2C_CLOCK_HZ` à `100000` dans `config.h` |
| `0x0D` ou `0x1E` présent | Magnétomètre d'un autre type (QMC5883L/HMC5883L) | Incompatible avec la librairie MPU9250 |

Le firmware affiche aussi la cause en clair (`[IMU] ECHEC : …`) et la remonte à
l'application dans le champ `imuDiag` du statut BLE — l'onglet *Réglages*
l'affiche sous la section Calibration.

> Le BLE reste **entièrement fonctionnel** en mode erreur capteur : on peut se
> connecter, régler et diagnostiquer le casque sans IMU opérationnelle.

## Mode dégradé « gyroscope seul » (MPU-6500)

### Comment reconnaître un faux MPU-9250
Le registre `WHO_AM_I` (0x75) ne ment pas :

| Valeur | Puce | Magnétomètre |
|---|---|---|
| `0x71` | MPU-9250 | ✅ AK8963 |
| `0x73` | MPU-9255 | ✅ AK8963 |
| `0x70` | **MPU-6500** | ❌ **aucun** |

Beaucoup de modules vendus « GY-9250 » embarquent en réalité un MPU-6500.
Le firmware l'affiche au démarrage et bascule automatiquement sur un pilote
MPU-6500 minimal intégré (`imu_manager.cpp`, espace de noms `mpu6500`), au lieu
de rester bloqué en mode erreur.

### Ce que le mode dégradé fournit — et ce qu'il ne fournit pas

| | État |
|---|---|
| Pitch / roll | ✅ **Stables**, référencés sur la gravité (filtre complémentaire, α = 0,98) |
| Cadence | ✅ 200 Hz (attente du bit *data ready*) |
| Cap | ⚠️ **RELATIF** : intégration du gyroscope Z, **aucune** référence absolue |
| Dérive mesurée | ⚠️ **≈ 1,8 °/min** après calibration du biais (banc, capteur immobile) |

Autrement dit : parfait pour valider la chaîne LED / BLE / PWA au banc,
**inutilisable pour naviguer en forêt**. Après 30 minutes, le cap peut être
faux de plus de 50°.

### Utilisation
1. **Calibrer le biais gyro** : commande série `g` (ou depuis l'app), capteur
   **immobile** ~3 s. Sauvegardé en NVS.
2. **Recaler le cap** aussi souvent que nécessaire : s'orienter à la boussole de
   poche, puis `z 90` en série — ou, dans l'app, le bandeau orange *Cap relatif*
   (saisir le cap réel, bouton **Recaler**).

Le champ `absolute` du statut BLE vaut `false` dans ce mode : l'application
affiche alors le bandeau d'avertissement et le contrôle de recalage.

## Alimentation batterie (V0.2 — prévu, non câblé)

Options identifiées dans la BOM :
- Simple : bloc « powerbank » 5 V USB-C existant → aucun circuit à concevoir.
- Intégré : Li-ion 18650/21700 protégée + chargeur **BQ24074/MCP73871** +
  boost/buck **TPS63070 ou MP2145** pour le rail 5 V des LED.
- Jauge : pont diviseur (2 × 100 kΩ) vers **GPIO 34**, à implémenter dans
  `readBatteryPercent()` ([main.cpp](../firmware/src/main.cpp)) — la
  caractéristique BLE batterie existe déjà.
