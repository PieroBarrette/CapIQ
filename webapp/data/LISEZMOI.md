# Coefficients du modèle magnétique mondial (WMM)

Ce dossier doit contenir **`WMM.COF`**, le fichier de coefficients officiel du
*World Magnetic Model*. Il alimente
[`geomag_service.js`](../src/geomag_service.js), qui calcule la déclinaison
magnétique à partir de la position GPS.

## Pourquoi ce fichier n'est pas dans le dépôt

Les coefficients sont **90 paires de valeurs de Gauss**. Des valeurs
approximatives ou recopiées de mémoire produiraient une déclinaison fausse
**sans que rien ne le signale** — exactement le genre d'erreur qui fait manquer
une placette de plusieurs dizaines de mètres. Ils doivent donc provenir de la
source officielle, et d'elle seule.

Tant que le fichier est absent, l'application le détecte, désactive la
conversion automatique et propose une saisie manuelle de la déclinaison.

## Comment l'obtenir

1. Aller sur <https://www.ncei.noaa.gov/products/world-magnetic-model>
2. Télécharger le **WMM2025 Coefficient File (WMM.COF)**
   (un court questionnaire est demandé par la NOAA avant le téléchargement).
3. Déposer le fichier ici, sous le nom exact **`WMM.COF`**.
4. Relancer l'application : l'onglet *Réglages* affichera le modèle chargé et
   son époque.

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
