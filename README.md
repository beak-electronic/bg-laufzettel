# BG Laufzettel (PWA)

Offline Progressive Web App: Baugruppenlaufzettel erzeugen, stempeln und per Scan öffnen.

**Live:** https://beak-electronic.github.io/bg-laufzettel/

**Version:** 1.4  
**©** BEAK electronic engineering GmbH & Co. KG

## Features

- Laufzettel-PDFs im Browser erzeugen (pdf-lib)
- Stempelmodus (Initialen, Datum, Apple Pencil)
- Scannen: DataMatrix/Barcode → Katalog-PDF
- Installierbare PWA (manifest + service worker)

## Lokal starten

```bash
python3 -m http.server 8765
# http://127.0.0.1:8765/  (HTTPS oder localhost für Kamera)
```
