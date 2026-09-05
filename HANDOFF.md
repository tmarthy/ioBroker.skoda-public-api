# Handoff — ioBroker.skoda-public-api

Diese Datei beschreibt den aktuellen Arbeitsstand und die nächsten notwendigen
Schritte. Nutzerinformationen stehen in [`README.md`](README.md), dauerhafte technische
Entscheidungen in [`docs/design-decisions.md`](docs/design-decisions.md) und die
technische Arbeitsgrundlage in
[`docs/implementation-plan.md`](docs/implementation-plan.md).

## Aktueller Stand

- Das öffentliche Repository ist
  [`tmarthy/ioBroker.skoda-public-api`](https://github.com/tmarthy/ioBroker.skoda-public-api).
- Auf npm und als GitHub-Release ist Version `0.1.0` veröffentlicht. Sie umfasst
  deutsch- und englischsprachige
  Backend-Texte, Benachrichtigungen, Verbindungstests und Objektnamen sowie korrigierte
  ioBroker-Rollen für String-States.
- Der Antrag auf Aufnahme in ioBroker `latest` ist als
  [`ioBroker.repositories#6592`](https://github.com/ioBroker/ioBroker.repositories/pull/6592)
  offen.
- npm Trusted Publishing ist für Tags über `.github/workflows/test-and-release.yml`
  eingerichtet. `NPM_TRUSTED_PUBLISHING=true` aktiviert den Deploy-Job.

## Offene Themen in empfohlener Reihenfolge

1. **Neuen Objekt-Export erzeugen und an PR #6592 anhängen.** Der vorhandene Export
   enthält elf inzwischen korrigierte Rollenfehler. Anschließend im PR `RE-CHECK!`
   kommentieren.
2. **`bluefox` als npm-Owner hinzufügen.** `npm owner ls
   iobroker.skoda-public-api` nennt aktuell nur `tmarthy`; dadurch bleibt Checker-Fehler
   `E2001` offen.
3. **Review von PR #6592 bearbeiten.** `W4001` verschwindet erst mit der Aufnahme in
   `latest`. Die Hinweise zu `process.env`, altem Changelog und Compact Mode sind zu
   bewerten, sofern sie im erneuten Check noch erscheinen.
4. **Schreibzugriffe für Ladelimit, Lademodus und Ladeprofile entwerfen.** Die API und
   die generierten Typen enthalten diese Operationen bereits; der Adapter spiegelt
   derzeit nur `vehicle.operations` und bietet dafür noch keine schreibbaren States.

## Funktionsumfang

Der Adapter liest Fahrzeugdaten über die offizielle MyŠkoda Public API und unterstützt
Start/Stop für Laden, Klimatisierung, Standheizung und Lüftung. Die VINs werden in der
Instanz konfiguriert, weil die API keine Fahrzeugliste anbietet.

Die API erlaubt **20 Requests pro Stunde und VIN**. Für jede VIN führt der Adapter
deshalb einen eigenen, persistenten Quota-Bucket unter `<vin>.rateLimit.*`. Polls
halten eine konfigurierbare Befehlsreserve frei. Befehle laufen über eine Queue mit
Coalescing und TTL; nach einer angenommenen Operation folgt ein Verifikations-Poll.

Der Objektbaum unter `<vin>` folgt der API-Antwort. States entstehen nur für gelieferte
Fahrzeugteile und werden nie automatisch gelöscht. Fehlende Daten behalten ihren
letzten Wert mit schlechtem Quality-Flag. Besondere Darstellungen sind:

- `charging.status.battery.remainingCruisingRangeInMeters`: Kilometer
- `activeVentilation.durationInSeconds`: Minuten
- `auxiliaryHeating.durationInSeconds`: Minuten
- `parkingPosition.position`: `lat;lon` für Karten und Geofencing
- Ladeprofile unter `chargingProfiles.profiles.<id>` statt nach Listenindex

Konfiguration und Objektbaum sind auf Deutsch und Englisch verfügbar. Logs,
Benachrichtigungen und Ergebnisse des Verbindungstests verwenden standardmäßig die
ioBroker-Systemsprache; die Instanz kann Deutsch oder Englisch erzwingen. Andere
Admin-Sprachen verwenden englische Backend-Texte als Fallback.

## Architektur

```text
src/main.ts
  ├─ config + i18n
  ├─ SkodaApiClient ── sanitize + typisierte API-Fehler
  ├─ VehicleQuotaManager ── ein persistenter QuotaManager pro VIN
  ├─ PollScheduler ── Kadenz, Backoff und Verifikations-Polls
  ├─ CommandQueue ── Coalescing, TTL und Retry-Strategie
  ├─ StateWriter ── Objektbaum, Quality-Flags und Metadatenmigration
  └─ KeyExpiryWatcher ── Ablauf-States, Logs und ioBroker-Notifications
```

| Bereich | Dateien |
|---|---|
| API-Vertrag und Codegen | `spec/skoda-openapi.json`, `tools/spec.mjs`, `tools/generate-*.mjs` |
| HTTP und Fehler | `src/lib/api/client.ts`, `errors.ts`, `sanitize.ts` |
| Quota | `src/lib/quota/QuotaManager.ts`, `VehicleQuotaManager.ts`, `AdapterQuotaStore.ts` |
| Polling und Befehle | `src/lib/scheduler/PollScheduler.ts`, `src/lib/commands/CommandQueue.ts` |
| States und Metadaten | `src/lib/states/StateWriter.ts`, `objectOverlay.ts`, `objectNames.ts` |
| Übersetzungen | `admin/i18n/*.json`, `i18n/de.json`, `i18n/en.json`, `src/lib/i18n.ts` |
| Entwicklungs-API | `test/mock/server.ts`, `test/fixtures/*.json` |
| Tests | Tests neben den Modulen, `test/package`, `test/integration.js` |

## Entwicklung und Prüfung

Voraussetzungen sind Node.js 22 oder neuer und `npm ci`.

```bash
npm run check
npm run lint
npm test
npm run build
```

Der Integrationslauf startet eine echte ioBroker-Testinstanz gegen den lokalen Mock und
dauert deutlich länger:

```bash
npm run test:integration
```

Der Mock läuft separat mit:

```bash
npm run mock
curl -H "X-API-Key: mock-api-key" \
  http://127.0.0.1:8099/api/v1/vehicles/TMBJB9NY5RF999999
```

Mit `SKODA_API_BASE_URL=http://127.0.0.1:8099` kann auch der dev-server den Mock
verwenden. Diese Variable darf auf einem Produktivsystem nicht gesetzt sein. In der
Admin-UI gibt es bewusst keine frei konfigurierbare API-Basis-URL.

Nach Änderungen an `src/` oder `admin/` benötigt der dev-server ein neu gebautes Paket
und einen Upload der Adapterdateien. `build/` bleibt unversioniert, muss aber im
npm-Paket enthalten sein; deshalb darf `.npmignore` nicht entfernt werden.

## CI und Release

Normale Pushes und Pull Requests führen nur die Mindestprüfung aus:

- TypeScript und ESLint auf Ubuntu mit Node 24
- Adaptertest auf Ubuntu mit Node 22

Tags `v*` und manuelle Läufe führen die vollständige Matrix auf Ubuntu, Windows und
macOS mit Node 22 und 24 aus. Reine Markdown- und `docs/`-Änderungen starten keinen
Workflow. Der wöchentliche Spec-Wächter läuft montags und kann manuell gestartet
werden. Dependabot prüft npm-Abhängigkeiten am 8. und GitHub Actions am 22. jedes
Monats.

Release-Prüfung:

```bash
npm run check
npm run lint
npm test
npm run test:integration
npm run build
npm pack --dry-run
npm run check:spec
```

`npm run check:spec` greift auf die Live-Spec zu. Bei einer Abweichung zuerst die neue
Spec prüfen, dann `npm run codegen` ausführen und die generierten Typen sowie
Objektdefinitionen gemeinsam aktualisieren.

## Betriebsrelevante Hinweise

- API-Key und S-PIN gehören ausschließlich in die Admin-UI. Beide Felder sind als
  `encryptedNative` und `protectedNative` hinterlegt.
- Der Verbindungstest kostet einen Request für die getestete VIN.
- `info.connection` wird bei `401` und `403` auf `false` gesetzt, bei erschöpfter Quota
  jedoch nicht.
- Ein abgelaufener Schlüssel reduziert das Polling auf einmal pro Stunde. Der Adapter
  kann keinen neuen Schlüssel erzeugen.
- Die API antwortet auf Befehle mit `202 Accepted` und bietet keinen Operationsstatus.
  `ack=true` bedeutet daher nur, dass der Befehl an die API übergeben wurde.
- Logs und Fehler müssen durch `sanitize()` laufen; VIN, API-Key, S-PIN, Adresse und
  Parkposition dürfen nicht in Support-Logs erscheinen.
- Die OpenAPI-Version ist `v0`. Änderungen am Vertrag und am Rate-Limit bleiben ein
  laufendes Risiko.
- Nur der Enyaq ist mit echten Fixtures abgedeckt. Angaben für Verbrenner, Hybrid und
  Standheizung beruhen auf Spec und Mock.

## Bewusst außerhalb des Adapters

- automatische Ermittlung von VINs
- Ver- und Entriegeln, Hupe oder Lichthupe
- Setzen des Ladestroms
- automatische Erneuerung des API-Schlüssels
- PV-Regelung; dafür gibt es `examples/pv-surplus-charging.js`
- Sentry oder andere externe Fehlertelemetrie
