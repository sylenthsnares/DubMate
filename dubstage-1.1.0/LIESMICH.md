# DubForge & DubStage

Szenen aus Videos selbst nachsprechen. **DubForge** zerlegt ein Video in einsprechbare Clips, **DubStage** nimmt deine Stimme auf und spielt die Szene am Stück damit ab.

*English version: `README_EN.md`*

---

## Einmalig einrichten

1. Alle Dateien in einen Ordner legen, z. B. `F:\DubForge`
2. **`Setup.bat`** doppelklicken

Das Setup holt Python-Pakete, lädt ffmpeg in einen `tools`-Unterordner und fragt, ob Demucs für die Stimmen-Trennung installiert werden soll. Demucs zieht PyTorch nach — mehrere hundert MB bis ~2 GB. Wenn du Nein sagst, läuft alles weiter, nur ohne Backing-Track.

Danach: **`Start DubForge.bat`** zum Bauen, **`Start DubStage.bat`** zum Einsprechen.

---

## Sprache umstellen

Oben rechts im Fenster: **Deutsch / English**. Wirkt sofort — Beschriftungen, Meldungen, Dialoge und Fehlertexte. Eingaben bleiben erhalten. Die Wahl wird gemerkt.

---

# DubForge — Packs bauen

**1. Quelle**

Entweder YouTube-Link einfügen oder eine lokale Datei wählen (MP4, MKV, MOV, WEBM, auch reine Audiodateien). Bei „Von" und „Bis" die Zeitspanne eintragen — `1:30`, `0:02:15.5` oder einfach `95` für Sekunden. Leer lassen = alles.

Dann **„Laden und analysieren"**. Das Tool lädt bzw. schneidet, extrahiert den Ton, trennt die Stimmen von Musik und Geräuschen und sucht selbst die Sprechabschnitte.

**2. Clips prüfen**

Die Wellenform zeigt die gefundenen Clips als Kästen.

| Aktion | Wie |
|---|---|
| Clip anhören | Doppelklick auf den Kasten |
| Clip auswählen | einfacher Klick |
| Anfang/Ende verschieben | Rand des Kastens ziehen |
| Neuen Clip anlegen | in leerem Bereich aufziehen |
| Umbenennen | Doppelklick in der Liste |
| Zoomen | Mausrad über der Wellenform |

Zu viele oder zu wenige Clips? **Empfindlichkeit** verstellen und **„Neu erkennen"**. Zu lange Clips? **Max. Cliplänge** runter und neu erkennen.

**Untertitel:** Unter der Liste gibt es ein Feld dafür. Clip anklicken, Text tippen, **Enter** — das speichert und springt gleich zum nächsten Clip. So arbeitest du dich ohne Mausklicks durch. DubStage zeigt den Text später groß unter dem Video an. Freiwillig: Clips ohne Untertitel funktionieren normal.

**3. Bauen**

Pack-Name eintragen, Häkchen bei **„Mit Video"** setzen (nötig für DubStage), dann **„Pack bauen"**. Der Pack landet im Ordner `packs` neben dem Tool — genau dort sucht DubStage. Über **„In Zielordner kopieren"** kannst du ihn zusätzlich woandershin legen.

## Was im Pack landet

| Datei | Wofür |
|---|---|
| `01_Name_44-048.wav` | Ein Clip. Die Zahl hinten ist der Startzeitpunkt im Video (44,048 s) |
| `dub_video.mp4` | Das Video zur Szene |
| `_backing_track.wav` | Musik und Geräusche ohne Stimmen |
| `_captions.json` | Die Untertitel, nach Clip-Dateiname |
| `_TIMESTAMPS.txt` | Übersicht aller Startzeiten samt Untertitel |
| `_README.txt` | Kurzinfo |

Alle Clips werden laut normalisiert (Peak −1 dBFS), damit beim Vergleich nicht die Lautstärke stört.

---

# DubStage — einsprechen

Pack auswählen → **Loslegen**. Pro Zeile:

| Knopf | Was passiert |
|---|---|
| **▶ Original** | Das Videostück läuft mit der Originalzeile |
| **● Aufnehmen** | 3-2-1, dann läuft dasselbe Stück und du sprichst drüber |
| **▶ Meine Aufnahme** | Deine Aufnahme direkt anhören, zum Video |
| **Zeile leer lassen** | Aufnahme verwerfen, die Zeile behält das Original |
| **‹ Zurück / Weiter ›** | Zeile wechseln |

Unter dem Video steht groß der **Untertitel** der Zeile. Die Leiste darüber zeigt alle Zeilen: grün = aufgenommen, gelb = wo du gerade bist. Direkt anklickbar, um zu springen.

Nach der letzten Zeile führt **Fertig** ins Finale: die ganze Szene läuft mit deiner Stimme, der Untertitel läuft mit. **Als Video speichern** legt eine MP4 im Ordner `dubs` ab. **‹ Zurück zu den Zeilen** geht jederzeit wieder rein.

Tastatur: **Leertaste** nimmt auf bzw. startet das Finale, **Esc** geht zurück.

## Der Vergleichsstreifen

Über der Knopfreihe liegt das eigentliche Werkzeug: die **Originalspur als blaue Silhouette**, darüber halbtransparent **deine Aufnahme** — beim Aufnehmen rot und live mitwachsend, danach grün. Eine goldene Marke zeigt, wo du gerade bist.

Beide Kurven teilen sich dieselbe Zeitachse, die bei Null des Clips beginnt. Damit siehst du auf einen Blick, ob du zu früh oder zu spät einsetzt und ob deine Pausen sitzen: liegen die Blöcke übereinander, passt das Timing. Der Streifen ist etwas breiter als das Original, weil nach dem Clip noch 0,7 Sekunden weiter aufgenommen wird — Platz, um den Satz zu Ende zu sprechen.

Beide Kurven werden auf ihre eigene Lautstärke normiert, verglichen wird also Rhythmus und nicht Pegel. Ist deine Aufnahme zu leise, steht das als Hinweis rechts unten.

## Mikrofon

Im Menü gibt es **Testen**: zwei Sekunden aufnehmen, Pegel ablesen, Wiedergabe. Falls nichts ankommt, im Auswahlfeld daneben ein anderes Gerät nehmen.

## Bildrate

Standard sind **25 Bilder pro Sekunde** bei 960 px Breite. Das Video wird dafür einmalig in Einzelbilder zerlegt und unter `%TEMP%\dubstage_cache` abgelegt, rund 37 MB pro Minute Video.

Falls dein Rechner ruckelt oder der Platz knapp wird, in `dubstage_settings.json` ändern:

```json
"video_fps": 20
```

Erlaubt sind 8 bis 30. Die Bilder werden beim nächsten Öffnen des Packs neu erzeugt.

## Packs, die nicht auftauchen

Gesucht wird im Ordner `packs` neben den Tools. Über **Ordner hinzufügen** lässt sich jeder weitere Ordner dauerhaft mit durchsuchen.

Damit ein Ordner als Pack zählt, braucht er ein **`dub_video`** (mp4, ogv, mkv, webm, mov oder avi) und mindestens einen Clip mit Zeitstempel im Dateinamen.

---

## Updates

Beide Werkzeuge fragen beim Start bei GitHub nach, ob es eine neuere Fassung
gibt — höchstens alle sechs Stunden. Wenn ja, erscheint oben ein Banner: es
nennt die Version, **Was ist neu** klappt den Changelog dieser Version auf, und
**Jetzt aktualisieren** spielt sie ein. Das Archiv wird geladen und geprüft, die
App schließt sich, die Dateien werden getauscht und die App startet neu — dauert
ein paar Sekunden.

`packs/`, `dubs/`, `tools/` und die Einstellungen werden dabei nie angefasst. Es
werden nur die Programmdateien ersetzt, und die alten landen vorher in einem
Sicherungsordner unter `%TEMP%`, mit einem Protokoll daneben.

Außer beim Herunterladen eines Videos, das du selbst angibst, ist das der
einzige Moment, in dem eines der Werkzeuge ins Netz geht — gesendet wird nichts.
Abschalten lässt es sich mit `"check_updates": false` in
`dubforge_settings.json` oder `dubstage_settings.json`.

---

## Wenn etwas klemmt

**Windows blockiert die BAT-Dateien** — Rechtsklick → Eigenschaften → unten **Zulassen**. Oder in PowerShell im Ordner: `Get-ChildItem -Recurse | Unblock-File`. Wichtig: die Dateien vorher aus dem Download-Ordner in einen normalen Ordner verschieben.

**„ffmpeg nicht gefunden"** — Setup.bat nochmal laufen lassen. Klappt das nicht: bei `gyan.dev/ffmpeg/builds` die **release full** ziehen und `ffmpeg.exe`, `ffprobe.exe`, `ffplay.exe` aus `bin` in `tools\` legen.

**YouTube-Download schlägt fehl** — Fast immer ist yt-dlp veraltet. YouTube ändert ständig etwas an der Auslieferung, deshalb hält das Werkzeug nur wenige Wochen. In DubForge oben rechts auf **yt-dlp aktualisieren** klicken; die Version samt Alter steht beim Start im Protokoll. Von Hand geht es im Terminal mit `py -m pip install --upgrade yt-dlp`.

**Demucs bricht ab** — Kein Beinbruch, das Tool schaltet automatisch auf den Originalton um. Dann fehlt nur der Backing-Track.

**Clips sitzen leicht daneben** — Bei YouTube-Downloads kann der Schnitt am Keyframe hängen. Zeitspanne ein paar Sekunden großzügiger setzen und im Editor nachjustieren.

**Mikrofon nimmt nichts auf** — Im DubStage-Menü ein anderes Gerät wählen und **Testen** drücken.

---

Beim Material bist du selbst dafür verantwortlich, nur zu verwenden, wozu du berechtigt bist.
