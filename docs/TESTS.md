# Capiq V0.1 — Plan de tests

Cocher à chaque campagne d'essai. Matériel : casque assemblé + téléphone
Android (Chrome) + PC pour le moniteur série.

## 0. Avant tout : auto-tests logiciels

| # | Test | Attendu |
|---|---|---|
| 0.1 | `pio run` dans `firmware/` | SUCCESS, 0 avertissement |
| 0.2 | Ouvrir `http://localhost:8080/tests/navigation.test.html` | Tous les tests verts (angles, distances, azimuts, Waypoint) |
| 0.3 | Console navigateur sur l'app : `capiq.demo()` | Aiguille qui tourne, bannière gauche/droite/aligné cohérente |

## 1. Bluetooth (BLE)

| # | Test | Procédure | Attendu |
|---|---|---|---|
| 1.1 | Publicité | Casque alimenté seul | LED « respiration » blanche ; « Capiq » visible dans nRF Connect |
| 1.2 | Connexion app | *Se connecter au casque* → choisir Capiq | Pastille verte « Connecté · Capiq », flash vert des LED, mode/batterie/fw renseignés |
| 1.3 | Envoi d'azimut | Régler 90° → ENVOYER AU CASQUE | Toast « Cible envoyée », flash blanc des LED, `stat cible = 90°` |
| 1.4 | Réception du cap | Tourner le casque à la main | « Cap actuel » et l'aiguille suivent (~5 Hz), erreur recalculée |
| 1.5 | Déconnexion | Éteindre le BT du téléphone | App : « Déconnecté » ; casque : flash orange puis **guidage LED conservé** |
| 1.6 | Reconnexion | Réactiver BT → Se connecter | Reprise en < 10 s, réglages re-poussés automatiquement |
| 1.7 | Persistance cible | Débrancher/rebrancher le casque | Le guidage reprend sur la dernière cible sans téléphone |

## 2. Hors ligne (PWA)

| # | Test | Procédure | Attendu |
|---|---|---|---|
| 2.1 | Installation | Menu Chrome → Ajouter à l'écran d'accueil | Icône Capiq, lancement plein écran |
| 2.2 | Coupure internet | Mode avion (**réactiver Bluetooth** ensuite), relancer l'app | App complète, bandeau « Hors ligne », BLE fonctionnel |
| 2.3 | Persistance | Modifier zone morte + cible, tuer l'app, relancer | Valeurs conservées (localStorage) |
| 2.4 | Mise à jour | Incrémenter `CACHE_NAME`, redéployer, rouvrir 2× | Nouvelle version servie |

## 3. Navigation / LED

Position de référence : debout, casque sur la tête, cible envoyée à 90° (Est).

| # | Test | Procédure | Attendu |
|---|---|---|---|
| 3.1 | Convention gauche/droite | Regarder vers 75° (cible 90°) | Erreur **+15°** → app « TOURNEZ À DROITE », LED **à droite** du centre, teinte verte-jaune |
| 3.2 | Symétrie | Regarder vers 123° | Erreur ≈ **−33°** → « TOURNEZ À GAUCHE », LED à gauche, plus orangée |
| 3.3 | Alignement | S'aligner sur 90° ± zone morte | LED centrale **verte** (respiration douce), app « ✓ ALIGNÉ » |
| 3.4 | Zone morte | Régler zone morte 10° puis 0.5° | La fenêtre « aligné » s'élargit/rétrécit en conséquence |
| 3.5 | Cible derrière | Regarder vers 270° (cible 90°) | LED d'extrémité **clignotante rouge** du côté du virage le plus court |
| 3.6 | Continuité | Balayer lentement 0→180° | Le point lumineux **glisse** sans saut (rendu sous-pixel), passage 359↔0 sans à-coup |
| 3.7 | Changement de cible | Envoyer 270° en cours de guidage | Flash blanc, guidage immédiatement recalculé |
| 3.8 | Luminosité | Régler 10 % puis 100 % | Variation nette ; à 100 % la consommation reste < plafond (pas de reboot USB) |

## 4. Calibration

| # | Test | Procédure | Attendu |
|---|---|---|---|
| 4.1 | Gyro/accel | Réglages → Calibrer gyroscope, casque posé à plat | Anim. bleue ~5 s, flash vert, statut « calibré » |
| 4.2 | Magnétomètre | Calibrer boussole, faire des 8, loin du métal | Anim. bleue ~20 s, flash vert ; cap comparé à une boussole de référence : écart < ~5° |
| 4.3 | Persistance | Redémarrer le casque | Statut toujours « calibré ✓ » (NVS) |
| 4.4 | Offset | Comparer cap Capiq vs boussole ; entrer l'écart dans *Offset azimut* → Appliquer | Cap corrigé |

## 5. Robustesse

| # | Test | Procédure | Attendu |
|---|---|---|---|
| 5.1 | IMU débranchée | Démarrer sans MPU-9250 | LED rouge clignotante (ERROR), BLE actif, app affiche « IMU non détectée » |
| 5.2 | Secousses | Marcher/secouer la tête | Cap stable (lissage), pas de LED erratique |
| 5.3 | Endurance | 30 min de guidage continu | Pas de reboot, fréquence IMU ~100+ Hz (`i` en série), pas d'échauffement anormal |

## Journal

| Date | Version fw/app | Testeur | Résultats / anomalies |
|---|---|---|---|
| | | | |
