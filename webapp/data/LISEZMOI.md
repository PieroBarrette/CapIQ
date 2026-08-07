# Coefficients du modèle magnétique mondial (WMM)

Ce dossier contient **`WMM.COF`**, le fichier de coefficients officiel du
*World Magnetic Model*, téléchargé depuis la NOAA. Il alimente
[`geomag_service.js`](../src/geomag_service.js), qui calcule la déclinaison
magnétique à partir de la position GPS.

**Fichier présent** : `WMM.COF`, WMM-2025, époque 2025.0, publié le
13 novembre 2024, degré 12 (90 paires de coefficients de Gauss).

## Provenance

Archive officielle
<https://www.ncei.noaa.gov/sites/default/files/2024-12/WMM2025COF.zip>,
accessible depuis <https://www.ncei.noaa.gov/products/world-magnetic-model>.

Les coefficients sont **90 paires de valeurs de Gauss**. Des valeurs
approximatives ou recopiées de mémoire produiraient une déclinaison fausse
**sans que rien ne le signale** — exactement le genre d'erreur qui fait manquer
une placette de plusieurs dizaines de mètres. C'est pourquoi ce fichier ne doit
jamais être édité à la main ni remplacé par une reconstitution.

Si le fichier venait à disparaître, l'application le détecte, désactive la
conversion automatique et bascule sur une saisie manuelle de la déclinaison.

## Validation

L'archive fournit aussi `WMM2025_TestValues.txt`, 100 valeurs de référence
couvrant 2025 à 2029,5, les deux hémisphères, des latitudes jusqu'à ±89° et des
altitudes de 0 à 100 km. Elles sont intégrées à
[`tests/navigation.test.html`](../tests/navigation.test.html) :

| Grandeur | Écart maximal constaté |
|---|---|
| Déclinaison | 0,005° |
| Inclinaison | 0,005° |
| Intensité totale | 0,0004 nT (sur ~50 000 nT) |

L'écart résiduel correspond à l'arrondi des références elles-mêmes, publiées au
centième de degré. Déclinaison calculée pour Rimouski : **−16,2°**.

## Mise à jour du fichier

1. Télécharger la nouvelle archive de coefficients sur le site de la NOAA.
2. Remplacer `WMM.COF` par celui de l'archive.
3. Mettre à jour le tableau de valeurs de référence dans la page de tests à
   partir du `TestValues.txt` livré avec, puis relancer les tests.

## Licence

Le WMM est produit par la NOAA/NCEI et le British Geological Survey. Le code
source et les coefficients sont dans le **domaine public**, librement
utilisables. Conformément au U.S. Code, toute œuvre dérivée doit mentionner la
contribution du gouvernement américain et préciser que ce matériel n'est pas
soumis au droit d'auteur.

## Validité

**WMM2025** couvre la période **2025 – 2029** (expiration le 31 décembre 2029).
Au-delà, l'extrapolation séculaire se dégrade : il faudra remplacer le fichier
par l'édition suivante. `getModelInfo()` expose l'époque et l'année limite pour
permettre à l'application d'avertir l'utilisateur.

## Format attendu

> ⚠️ Les nombres ci-dessous illustrent **uniquement la disposition des
> colonnes**. Ce ne sont pas des coefficients valides : ne les recopiez pas.
> Seul le fichier téléchargé depuis la NOAA fait foi.

```
    <époque>          <nom du modèle>   <date>
  n  m      gnm       hnm       dgnm       dhnm
  1  0   -00000.0       0.0        0.0        0.0
  1  1   -00000.0       0.0        0.0        0.0
  ...
9999999999999999999999999999999999999999999999999999999999999999
```

Ligne d'en-tête (époque, nom, date), puis `n m gnm hnm dgnm dhnm`,
terminé par une ligne de 9999. C'est exactement ce que `loadModel()` analyse.
