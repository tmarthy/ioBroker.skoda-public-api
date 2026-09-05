# Technische Arbeitsgrundlage und offene Umsetzung

Dieses Dokument beschreibt die aktuelle Implementierung und die noch geplanten
Erweiterungen. Dauerhafte Produkt- und Architekturentscheidungen stehen in
[`design-decisions.md`](design-decisions.md); der operative Projektstatus steht in
[`../HANDOFF.md`](../HANDOFF.md).

## 1. Systemgrenzen

Der Adapter bindet die offizielle MyŠkoda Public API an ioBroker an. Die API bestimmt
folgende Grenzen:

- statischer, an ausgewählte VINs gebundener API-Key
- 20 Requests pro Stunde und VIN
- ein Lese-Endpunkt und keine Fahrzeugliste
- keine Push-Nachrichten oder Webhooks
- Befehlsannahme mit `202 Accepted`, aber kein Operationsstatus
- keine automatische Schlüsselerneuerung
- OpenAPI-Version `v0` mit möglichen Vertragsänderungen

Diese Grenzen machen Quota-Verwaltung, persistente Zeitfenster, adaptive Poll-Kadenz
und einen vollständigen lokalen Mock zu Bestandteilen des Produktverhaltens.

## 2. Aktuelle Architektur

| Baustein | Verantwortung |
|---|---|
| `src/main.ts` | ioBroker-Lebenszyklus, Initialisierung und Verdrahtung |
| `src/lib/config.ts` | Validierung, Defaults und Umrechnung der Instanzkonfiguration |
| `src/lib/i18n.ts` | Deutsch/Englisch für Backend-Texte |
| `src/lib/api/client.ts` | HTTP-Aufrufe, Header-Metadaten und typisierte Ergebnisse |
| `src/lib/api/errors.ts` | Zuordnung der API-Fehler gemäß Abschnitt 5 |
| `src/lib/api/sanitize.ts` | Maskierung sensibler Daten vor Log-Ausgaben |
| `src/lib/quota/*` | ein persistenter Stunden-Bucket pro VIN |
| `src/lib/scheduler/PollScheduler.ts` | Poll-Reihenfolge, Frische-Backoff und Verifikations-Polls |
| `src/lib/commands/CommandQueue.ts` | TTL, Coalescing, Reserve und Retries |
| `src/lib/states/StateWriter.ts` | Objektanlage, Werte, Quality-Flags und Migrationen |
| `src/lib/states/objectOverlay.ts` | Rollen, Einheiten, Enum-Labels und Anzeigeumrechnungen |
| `src/lib/states/objectNames.ts` | deutsche und englische Objektnamen |
| `src/lib/notifications/keyExpiry.ts` | Ablaufüberwachung und ioBroker-Notifications |
| `test/mock/*` | steuerbarer Ersatz für die quota-begrenzte Live-API |

Die Startreihenfolge ist verbindlich: Zuerst werden Konfiguration und Sprache geladen,
danach die persistenten Quota-Buckets. Erst dann starten CommandQueue und PollScheduler.
So erzeugt eine Neustartschleife kein scheinbar frisches Request-Budget.

## 3. Verhalten und Invarianten

### Polling und Quota

- Jede VIN besitzt einen eigenen `QuotaManager`.
- Antwortheader sind die Quelle der Wahrheit für Limit, Restbudget und Reset-Zeit.
- Polling verwendet die Befehlsreserve nicht.
- Ein unveränderter `carCapturedTimestamp` verdoppelt die Poll-Kadenz bis zur
  konfigurierten Obergrenze.
- Aktivität oder ein gesendeter Befehl setzt die Kadenz zurück.
- Poll-Durchläufe sind serialisiert; ein angeforderter Verifikations-Poll geht während
  eines laufenden Durchlaufs nicht verloren.
- Quota-Daten liegen unter `<vin>.rateLimit.*` und überleben Neustarts.

### Befehle

- `enabled` bildet den Sollzustand ab; `start` und `stop` erzwingen einen Aufruf.
- Gleiche Sollwerte werden bei bekannt passendem Ist oder während einer offenen
  Bestätigung zusammengeführt.
- Die Bestätigungsfrist entspricht der Command-TTL. Ein neuerer Fahrzeugzeitstempel mit
  passendem Ist beendet sie vorzeitig.
- Befehle ohne verfügbares Budget warten bis zu ihrer TTL in der Queue.
- Nach `202 Accepted` wird nach 60 Sekunden ein Verifikations-Poll angefordert.
- `ack=true` bestätigt die Übergabe an die API, nicht die Ausführung im Fahrzeug.

### Objektbaum

- Objekte entstehen nur für tatsächlich gelieferte Fahrzeugteile.
- Der Adapter löscht keine Objekte automatisch.
- Fehlende oder fehlerhafte Teile behalten den letzten Wert mit schlechtem
  Quality-Flag; zurückkehrende Werte erhalten wieder gute Qualität.
- Ladeprofile werden nach Profil-ID abgebildet.
- Benutzerdefinierte Objektnamen und Rollen bleiben bei Metadatenänderungen erhalten.
  Nur bekannte frühere Standardnamen und nachweislich fehlerhafte Adapter-Rollen werden
  migriert.
- Anzeigeumrechnungen betreffen nur State-Werte und Metadaten:
  Restreichweite wird in km, Lüftungs- und Standheizungsdauer in Minuten dargestellt.
  API-Antworten, Fixtures und Befehlsdaten bleiben unverändert.

### Datenschutz und Sprache

- API-Key und S-PIN sind `encryptedNative` und `protectedNative`.
- VIN, Schlüssel, S-PIN, Adresse und Positionsdaten dürfen keine Modulgrenze in rohen
  Fehlermeldungen verlassen.
- Admin-UI, Objektbezeichnungen, Logs, Notifications und Verbindungstest sind auf
  Deutsch und Englisch verfügbar.
- Die Instanzsprache ist `system`, `de` oder `en`; andere Systemsprachen fallen
  für Backend-Texte auf Englisch zurück.

## 4. Entwicklung, Tests und Release

Lokale Mindestprüfung:

```bash
npm run check
npm run lint
npm test
npm run build
```

Für Änderungen an Scheduling, Quota, Befehlen, Persistenz, Objektmigration oder
Adapter-Lebenszyklus ist zusätzlich `npm run test:integration` erforderlich. Änderungen
am API-Vertrag benötigen `npm run check:spec`, anschließend bei Bedarf
`npm run codegen` und die Prüfung der generierten Diffs.

Der Mock ist das Entwicklungssystem für API-Verhalten:

```bash
npm run mock
SKODA_API_BASE_URL=http://127.0.0.1:8099 npx iobroker-dev-server run default
```

Normale Pushes und Pull Requests führen TypeScript, ESLint und einen Ubuntu-Test mit
Node 22 aus. Tags und manuelle Workflow-Läufe prüfen Ubuntu, Windows und macOS mit
Node 22 und 24. Ein Versions-Tag veröffentlicht über npm Trusted Publishing und erzeugt
den GitHub-Release.

Vor einem Release:

1. offene Changelog-Einträge prüfen
2. vollständige lokale Prüfung einschließlich Integrationstest ausführen
3. vollständigen GitHub-Workflow manuell ausführen
4. `npm pack --dry-run` prüfen; `build/main.js` und `i18n/de.json` müssen enthalten sein
5. Version mit `npm run release` vorbereiten
6. Release-Commit und Tag pushen
7. npm-Paket und GitHub-Release kontrollieren

## 5. Fehlerbehandlung

| Antwort | Quota | Retry | Reaktion |
|---|---|---|---|
| `202 Accepted` | ja | — | Verifikations-Poll nach 60 s |
| `400 Bad Request` | ja | nein | Adapterfehler loggen, Befehl verwerfen |
| `401 api-key-expired` | nein | nein | `connection=false`, Notification, Polling einmal pro Stunde |
| `403 api-key-not-authorized` | nein | nein | `connection=false`, Konfigurationshinweis |
| `403 operation-not-authorized` | ja | nein | Befehl verwerfen und loggen |
| `404 Not Found` | ja | nein | VIN prüfen, Polling für diese VIN aussetzen |
| `422 operation-not-supported` | ja | nein | Fähigkeit dauerhaft merken, State deaktivieren |
| `422 operation-disabled` | ja | nein | Befehl verwerfen, Fähigkeit nicht dauerhaft ändern |
| `429 rate-limit-exceeded` | nein | bis TTL | `Retry-After` abwarten, Befehl in Queue lassen |
| `429 vehicle-not-accepting-requests` | nein | max. 3 | `Retry-After` und Backoff |
| `500`, `503`, `504` | ja | max. 1 | Jitter; nur oberhalb der Befehlsreserve |
| Netzwerkfehler oder Timeout | unbekannt | max. 1 | konservativ als verbraucht zählen |

Die `RateLimit-*`-Header korrigieren lokale Schätzungen. Insbesondere wird
`403 operation-not-authorized` konservativ als quotaverbrauchend behandelt, obwohl
die allgemeine API-Regel 403-Antworten ausnimmt. Ein Netzwerkfehler kann nach
serverseitiger Buchung entstehen und zählt deshalb ebenfalls konservativ als verbraucht.

## 6. Offene Umsetzung

### ioBroker Latest

- neue Objektstruktur aus einer laufenden Instanz exportieren und an
  [`ioBroker.repositories#6592`](https://github.com/ioBroker/ioBroker.repositories/pull/6592)
  anhängen
- Checker erneut starten und verbleibende Befunde bearbeiten
- `bluefox` als npm-Owner hinzufügen
- manuellen ioBroker-Review bis zur Aufnahme in `latest` begleiten

### Zusätzliche Schreiboperationen

Ladelimit, Lademodus und Ladeprofile benötigen vor der Umsetzung ein eigenes
State-Modell. Dabei sind mindestens zu klären:

- Soll-States und Validierungsregeln
- Fähigkeitserkennung über `vehicle.operations`
- Quota-Kosten und Coalescing je Operation
- sichere Behandlung vollständiger Ladeprofil-Payloads
- Rückmeldung und Verifikation ohne Operationsstatus
- Migration und Dokumentation der neuen Objekte

### Laufende Wartung

- Änderungen der OpenAPI-`v0`-Spec prüfen und Codegen anpassen
- Abhängigkeiten und GitHub Actions über Dependabot aktuell halten
- Verhalten weiterer Fahrzeugtypen mit anonymisierten Fixtures absichern
- Compact Mode erst nach Bewertung von Lebenszyklus, Timern und Speicherzustand
  aktivieren
