# Capiq — Prototype V0.1

Système de guidage directionnel pour casque forestier : l'utilisateur choisit un
azimut cible sur son téléphone, le casque (ESP32 + IMU + bande LED) indique en
temps réel dans quelle direction tourner la tête pour suivre ce cap.

```
     TÉLÉPHONE (PWA)                    CASQUETTE
  ┌──────────────────┐   Bluetooth   ┌──────────────────────────┐
  │  Cadran boussole │      LE       │  ESP32 ──I2C── MPU-9250  │
  │  Azimut cible    │ ◄──────────►  │    │                     │
  │  Cap / erreur    │  JSON 5-20 Hz │    └─GPIO13─► SK6812 RGBW│
  │  Réglages, cal.  │               │        (15 LED, visière) │
  └──────────────────┘               └──────────────────────────┘
```

- **Convention d'erreur** (partout dans le projet) : `erreur = cible − cap`,
  ramenée dans ±180°. **Positif = tourner à droite** → LED côté droit.
- V0.1 : guidage par azimut seul. L'architecture prépare la V0.2 : GPS,
  waypoints, cartes hors ligne, GPX/GeoJSON (QGIS), GSFNAV — voir la BOM et
  `webapp/src/navigation_service.js`.

## Structure du dépôt

| Dossier | Contenu |
|---|---|
| [firmware/](firmware/) | Projet PlatformIO (ESP32, framework Arduino) |
| [webapp/](webapp/) | PWA hors ligne (HTML/CSS/JS vanilla, Web Bluetooth) |
| [docs/](docs/) | [Câblage](docs/HARDWARE.md) · [Protocole BLE](docs/PROTOCOLE_BLE.md) · [Plan de tests](docs/TESTS.md) |
| [tools/](tools/) | `serve.ps1` (serveur local), `make_icons.ps1` (icônes PWA) |

---

## 1. Matériel et branchements

| Composant | Broche composant | Pin ESP32 (DevKit WROOM-32) | Fonction |
|---|---|---|---|
| MPU-9250 (GY-9250) | VCC | **3V3** | Alimentation 3.3 V |
| MPU-9250 | GND | **GND** | Masse |
| MPU-9250 | SDA | **GPIO 21** | Données I2C |
| MPU-9250 | SCL | **GPIO 22** | Horloge I2C |
| SK6812 RGBW | VCC (5V) | **VIN / 5V** | Alimentation 5 V (USB) |
| SK6812 RGBW | GND | **GND** | Masse commune |
| SK6812 RGBW | DATA IN | **GPIO 13** (via R 330 Ω) | Signal LED |

GPIO choisis pour éviter les broches de strapping (0, 2, 5, 12, 15), les broches
flash (6-11) et les broches input-only (34-39). Le BLE n'occupe aucun GPIO.
Sur **ESP32-S3** (cible future de la BOM), `config.h` bascule automatiquement
sur SDA=8 / SCL=9. **GPIO 34** est réservé à la future mesure de batterie.

⚠️ **À lire avant de souder** : niveau logique 3.3 V → 5 V, budget de courant
USB, condensateur tampon : voir [docs/HARDWARE.md](docs/HARDWARE.md).

---

## 2. Firmware (ESP32)

### Prérequis
- Visual Studio Code + extension **PlatformIO IDE**
- Câble USB données

### Compiler et téléverser
Ouvrir le dossier **`firmware/`** dans VS Code (PlatformIO le détecte), puis :

```
pio run                  # compiler (env. par défaut : esp32dev)
pio run -t upload        # téléverser
pio device monitor       # moniteur série 115200 bauds
pio run -e esp32-s3-devkitc-1   # variante ESP32-S3
```

État vérifié : **compile sans erreur ni avertissement** (RAM 11 %, Flash 21 %).

### Première mise en service
1. Téléverser, ouvrir le moniteur série : la bande LED fait un balayage vert
   puis « respire » en blanc (mode attente).
2. Calibrer le capteur (une fois par montage) — depuis l'app (Réglages →
   Calibration) ou la console série :
   - `g` : gyro/accéléromètre — casque **immobile à plat**, ~5 s ;
   - `m` : magnétomètre — dessiner des **8** dans tous les axes, ~20 s,
     **loin de tout métal**. La calibration est sauvegardée en mémoire flash.
3. Console série de banc d'essai : `t 90` (cible), `c` (cap), `b 40`
   (luminosité), `i` (statut JSON), `h` (aide).

### Choix techniques (et pourquoi)
- **Adafruit NeoPixel** plutôt que FastLED : FastLED ne gère pas nativement le
  canal blanc des SK6812 **RGBW** ; NeoPixel oui, avec sortie RMT stable
  pendant l'activité BLE.
- **NimBLE-Arduino** plutôt que Bluedroid : ~40 % de flash/RAM en moins, plus
  stable.
- **hideakitai/MPU9250** : fusion Madgwick intégrée, calibration accessible,
  gestion du magnétomètre AK8963.
- L'IMU est isolée derrière `IMUManager` (aucun type de librairie exposé) :
  le passage au **BNO085** de la version finale ne touchera que
  `imu_manager.cpp`. Les **limites du MPU-9250** (clones sans magnétomètre,
  dérive, sensibilité magnétique) sont documentées dans
  [imu_manager.h](firmware/src/imu_manager.h).
- Cap **magnétique** par défaut ; pour un cap géographique, régler
  `MAG_DECLINATION_DEG` dans [config.h](firmware/src/config.h)
  (~ −16° région Rimouski-Neigette, à vérifier sur le calculateur NRCan).

---

## 3. Application web (PWA)

### Lancer localement (PC)
Au choix, depuis la racine du projet :

```powershell
# Option A — aucun prérequis (Windows)
powershell -ExecutionPolicy Bypass -File tools\serve.ps1

# Option B — si Python est installé
python -m http.server 8080 -d webapp
```

Puis ouvrir **http://localhost:8080** dans Chrome ou Edge.
Sans casque sous la main, taper `capiq.demo()` dans la console (F12) pour
simuler la télémétrie et voir l'interface vivre.

### Tester sur téléphone Android
Web Bluetooth et le Service Worker exigent un **contexte sécurisé**
(HTTPS ou localhost). Une simple adresse `http://192.168.x.x` **ne marchera pas**.
Deux méthodes :

**A. Développement — redirection de port USB (recommandé)**
1. Sur le téléphone : activer les *Options développeur* + *Débogage USB*.
2. Brancher le téléphone au PC, lancer le serveur local (ci-dessus).
3. Sur le PC, dans Chrome : `chrome://inspect` → *Port forwarding* →
   ajouter `8080` → `localhost:8080`, cocher *Enable port forwarding*.
4. Sur le téléphone, ouvrir `http://localhost:8080` dans Chrome.

**B. Terrain — hébergement HTTPS (une fois)**
Publier le dossier `webapp/` tel quel (aucune étape de build) sur un hébergeur
statique HTTPS : GitHub Pages, Netlify, Cloudflare Pages… Après la première
visite, l'application fonctionne **sans aucune connexion internet**.

### Installer comme application (écran d'accueil)
1. Ouvrir l'app dans Chrome Android (via A ou B).
2. Menu ⋮ → **« Ajouter à l'écran d'accueil »** / **« Installer l'application »**
   (ou le bouton *Installer* dans l'onglet Réglages de Capiq).
3. L'app s'ouvre alors plein écran, icône Capiq, sans barre d'adresse.

### Activer le Bluetooth
1. Android : activer le **Bluetooth** (et la **Localisation** sur Android ≤ 11 —
   exigence Android pour le scan BLE ; permission « Appareils à proximité » sur
   Android 12+).
2. Dans Capiq : **Se connecter au casque** → choisir « Capiq » dans le
   sélecteur Chrome.
3. La connexion est mémorisée par le casque ; en cas de coupure, refaire
   *Se connecter*. Le casque continue de guider seul avec la dernière cible
   même téléphone éteint.

⚠️ **iOS/Safari ne supporte pas Web Bluetooth** : Android requis pour la V0.1.

### Fonctionner sans internet
- Le Service Worker met tout l'app shell en cache dès la première visite :
  les visites suivantes fonctionnent en avion/forêt sans réseau.
- Réglages, dernière cible et (futurs) waypoints sont conservés localement
  (`localStorage` derrière [storage_service.js](webapp/src/storage_service.js)).
- Test : mode avion (Bluetooth réactivé manuellement) → relancer l'app →
  tout fonctionne, bandeau « Hors ligne » affiché.

### Version distribuable
Le dossier `webapp/` **est** la version distribuable (100 % statique, zéro
build, zéro dépendance). Pour livrer : zipper `webapp/` ou pousser sur un
hébergeur HTTPS. Pour une mise à jour : incrémenter `CACHE_NAME` dans
[service-worker.js](webapp/service-worker.js).

---

## 4. Tests

- Plan de tests complet (BLE, hors ligne, guidage LED) :
  [docs/TESTS.md](docs/TESTS.md)
- Auto-tests des calculs de navigation (angles, distances, azimuts) :
  ouvrir `http://localhost:8080/tests/navigation.test.html`
- Protocole BLE détaillé (UUID, trames JSON) :
  [docs/PROTOCOLE_BLE.md](docs/PROTOCOLE_BLE.md)

---

## 5. Feuille de route

| Version | Contenu |
|---|---|
| **V0.1 (ceci)** | Azimut manuel, guidage LED, PWA hors ligne, calibration |
| V0.2 | Batterie Li-ion + jauge ADC, GPS téléphone → cap vers waypoint (`NavigationService` déjà prêt), import GPX/GeoJSON |
| V0.3+ | Cartes OSM hors ligne, points forestiers, intégration GSFNAV, BNO085, capteur de luminosité (auto-dim), retour haptique |
