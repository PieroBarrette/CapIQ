# Capiq V0.1 — Protocole Bluetooth Low Energy

Nom annoncé : **`Capiq`** · MTU préféré : 247 · Puissance TX : +9 dBm
Appairage : aucun (connexion ouverte — prototype).

## Services et caractéristiques

| Rôle (spec) | UUID | Propriétés | Contenu |
|---|---|---|---|
| Service Capiq | `ca910000-56e8-4b3a-9a2f-d3f1a2b4c5d6` | — | Service principal |
| TARGET_AZIMUTH | `ca910001-…` | WRITE, WRITE_NR | Azimut cible |
| CURRENT_HEADING (télémétrie) | `ca910002-…` | READ, NOTIFY | Trame télémétrie JSON |
| STATUS | `ca910003-…` | READ, NOTIFY | État système JSON |
| COMMAND | `ca910004-…` | WRITE, WRITE_NR | Commandes JSON |
| BATTERY_LEVEL | Service standard `0x180F`, carac. `0x2A19` | READ, NOTIFY | Octet 0-100 % |

Tous les UUID personnalisés partagent la base `ca91xxxx-56e8-4b3a-9a2f-d3f1a2b4c5d6`
(définis dans [config.h](../firmware/src/config.h) et
[ble_service.js](../webapp/src/ble_service.js) — **à maintenir identiques**).

## Trames

### TARGET_AZIMUTH (téléphone → casque)
```json
{"target": 90}
```
Le firmware accepte aussi un nombre nu (`"90"`) pour les tests avec nRF Connect.
Valeur normalisée 0-360, persistée en NVS (le casque garde sa cible après reboot).

### Télémétrie (casque → téléphone, cadence réglable 1-20 Hz, défaut 5 Hz)
```json
{"target":90,"error":2.5,"heading":87.5,"battery":100,"pitch":1.2,"roll":-0.8}
```
- `error = wrap180(target − heading)` : **positif = tourner à droite**.
- `target`/`error` valent `null` tant qu'aucune cible n'a été définie.
- `battery` : fixé à 100 en V0.1 (alimentation USB).

### STATUS (casque → téléphone, à chaque changement + max 1 Hz)
```json
{"fw":"0.1.0","mode":"DIRECTION","imu":true,"mag":true,"cal":true,
 "rate":98,"deadzone":2,"brightness":60,"rateHz":5,"offset":0,"hasTarget":true}
```
`mode` ∈ `BOOT | CONNECTION | DIRECTION | CALIBRATION | ERROR`.
`rate` = fréquence IMU réellement mesurée (Hz).

### COMMAND (téléphone → casque)
| Commande | Effet |
|---|---|
| `{"cmd":"set","deadzone":2,"brightness":60,"rate":5,"offset":0}` | Applique + persiste les réglages (champs optionnels) |
| `{"cmd":"cal_imu"}` | Calibration gyro/accel (~5 s, immobile) |
| `{"cmd":"cal_mag"}` | Calibration magnétomètre (~20 s, faire des 8) |
| `{"cmd":"reset_cal"}` | Efface la calibration sauvegardée |

## Comportements
- À la **connexion** de l'app : elle pousse ses réglages puis sa cible
  (l'app est la source de vérité de la configuration).
- À la **déconnexion** : le casque reprend la publicité BLE et **continue le
  guidage** avec la dernière cible (le téléphone peut dormir dans la poche).
- Pendant une **calibration** : télémétrie suspendue (~5-20 s), la bande LED
  affiche l'animation bleue ; l'app affiche un compte à rebours local.
- Les champs JSON inconnus sont ignorés des deux côtés → les évolutions
  (GPS, waypoints, logs) restent rétro-compatibles ; UUID `ca910005+`
  réservés aux futures caractéristiques.

## Déboguer sans l'app
[nRF Connect (Android)](https://play.google.com/store/apps/details?id=no.nordicsemi.android.mcp) :
se connecter à « Capiq », s'abonner à `ca910002` (télémétrie), écrire `90` sur
`ca910001` → la bande LED réagit.
