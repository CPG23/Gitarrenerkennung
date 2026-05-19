# Gitarrenerkennung

Eine kleine Browser-App, die ueber das Mikrofon Musik analysiert und daraus:

- dominante Noten erkennt
- Frequenzen live anzeigt
- moegliche Gitarrenpositionen nennt
- einfache Akkordvorschlaege macht
- die Musikart grob aus Tempo, Tonvielfalt und Klangenergie einschaetzt

## Online verwenden

Wenn dieses Repository auf GitHub Pages veroeffentlicht ist, ist die App unter dieser Adresse erreichbar:

`https://cpg23.github.io/Gitarrenerkennung/`

Der Browser fragt beim Starten der Analyse nach Mikrofonzugriff. Die Analyse laeuft lokal im Browser; es wird kein Audio an einen Server gesendet.

## Lokal starten

Falls Node.js installiert ist:

```bash
node server.mjs
```

Danach im Browser oeffnen:

`http://127.0.0.1:4173`

Alternativ kann `index.html` direkt im Browser geoeffnet werden. Je nach Browser ist Mikrofonzugriff ueber `file://` eingeschraenkt; ueber den lokalen Server funktioniert es zuverlaessiger.
