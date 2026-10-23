# Pendel – meine Bahnstrecken

Kleine Web-App (PWA) fürs iPhone: feste Strecken mit einem Tipp abfragen, mit Echtzeit, Gleis, Ausfällen, Halteliste und Karte.

- Reines Frontend (HTML, CSS, Vanilla JS), kein Build-Schritt
- Daten: [Transitous](https://transitous.org) (MOTIS 2 API, kostenlos, ohne Key). Basis-URL steht oben in `app.js` (`API_BASE`).
  `v6.db.transport.rest` ist seit 2026 abgeschaltet.
- Karte: Leaflet + OpenStreetMap
- Strecken werden im Browser gespeichert (localStorage)

## Dateien

| Datei | Inhalt |
|---|---|
| `index.html` | Seitengerüst |
| `app.js` | gesamte Logik (Startseite, Verbindungen, Details, Verwalten) |
| `style.css` | Design inkl. Dark Mode |
| `manifest.json`, `sw.js`, `icons/` | PWA (Home-Bildschirm, Offline-Hülle) |

## Lokal testen

```bash
python3 -m http.server 8765
```

Dann http://localhost:8765 öffnen.

## Veröffentlichen mit GitHub Pages

1. Auf github.com ein neues **öffentliches** Repository anlegen, z. B. `pendel` (ohne README).
2. Im Ordner dieses Projekts:
   ```bash
   git remote add origin https://github.com/<DEIN-NAME>/pendel.git
   git push -u origin main
   ```
3. Im Repo auf GitHub: **Settings → Pages → Build and deployment → Source: „Deploy from a branch“**, Branch `main`, Ordner `/ (root)`, **Save**.
4. Nach 1–2 Minuten ist die App unter `https://<DEIN-NAME>.github.io/pendel/` erreichbar.
5. Auf dem iPhone in **Safari** öffnen → Teilen-Symbol → **„Zum Home-Bildschirm“**.

Updates: Dateien ändern, `git commit` und `git push` – GitHub Pages aktualisiert sich automatisch.

## Nutzungsbedingungen Transitous

Transitous ist ein ehrenamtlicher Dienst für nicht-kommerzielle Open-Source-Projekte. Deshalb: Code öffentlich (MIT-Lizenz), Quellenhinweis in der App, wenige Anfragen (Auto-Aktualisierung nur bei geöffneter App, pausiert im Hintergrund).
