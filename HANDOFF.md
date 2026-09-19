# Handoff — ioBroker.skoda-public-api

Diese Datei beschreibt den aktuellen Arbeitsstand und die nächsten notwendigen
Schritte. Nutzerinformationen stehen in [`README.md`](README.md), dauerhafte technische
Entscheidungen in [`docs/design-decisions.md`](docs/design-decisions.md) und die
technische Arbeitsgrundlage in
[`docs/implementation-plan.md`](docs/implementation-plan.md).

## Aktueller Stand

- Das öffentliche Repository ist
  [`tmarthy/ioBroker.skoda-public-api`](https://github.com/tmarthy/ioBroker.skoda-public-api).
- Auf npm ist Version `0.1.9` veröffentlicht (geprüft am 19. September 2026).
  `package.json` und `io-package.json` stehen ebenfalls auf `0.1.9`.
  Der Entwicklungsstand enthält zusätzlich unter anderem den manuellen Refresh
  und das schreibbare Ladelimit; unveröffentlichte Änderungen stehen im README-Changelog.
- Der Antrag auf Aufnahme in ioBroker `latest` ist als
  [`ioBroker.repositories#6592`](https://github.com/ioBroker/ioBroker.repositories/pull/6592)
  weiterhin offen (geprüft am 19. September 2026).
- `bluefox` und `tmarthy` sind als npm-Maintainer eingetragen (am selben Tag geprüft).
  Die frühere Aufgabe, `bluefox` hinzuzufügen, ist damit erledigt.
- npm Trusted Publishing ist für Tags über `.github/workflows/test-and-release.yml`
  eingerichtet. `NPM_TRUSTED_PUBLISHING=true` aktiviert den Deploy-Job.

## Offene Themen in empfohlener Reihenfolge

1. **Aktuellen Review- und Checker-Stand von PR #6592 prüfen.** Frühere Hinweise zu
   Objektrollen, npm-Ownern, `process.env`, Changelog und Compact Mode nicht ungeprüft
   als offene Fehler übernehmen. Entsprechende Korrekturen bzw. Unterstützung sind
   inzwischen vorhanden. Bei Bedarf einen aktuellen Objekt-Export bereitstellen und
   einen erneuten Check anfordern; der aktuelle Kommentarverlauf wurde hier nicht geprüft.
2. **Nächstes Release vorbereiten.** Unveröffentlichte Änderungen prüfen, insbesondere
   manuelles Refresh und Ladelimit, und die unten beschriebene Release-Prüfung ausführen.
3. **Schreibzugriffe für Lademodus und Ladeprofile entwerfen.** Die API und
   die generierten Typen enthalten diese Operationen bereits; der Adapter spiegelt
   derzeit nur `vehicle.operations` und bietet dafür noch keine schreibbaren States.

## Funktionsumfang

Der Adapter liest Fahrzeugdaten über die offizielle MyŠkoda Public API und unterstützt
Start/Stop für Laden, Klimatisierung, Standheizung und Lüftung sowie das Ladelimit
über `charging.settings.targetStateOfChargeInPercent` (50–100 % in 10-Prozent-Schritten).
Derselbe Datenpunkt wird bei Polls mit der gemeldeten Einstellung aktualisiert. Die VINs
werden in der Instanz konfiguriert, weil die API keine Fahrzeugliste anbietet.

Die `*.enabled`-Schalter akzeptieren ausschließlich Boolean `true` und `false`.
Andere Werte werden ohne API-Aufruf, Quittierung oder Änderung wartender Befehle
ignoriert. `<vin>.refresh` fordert einen vorgezogenen Poll an; Quota, Befehlsreserve
und Fehlerwartezeiten gelten dabei weiterhin.

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

Konfiguration und adapterdefinierte Objektnamen sind in allen elf unterstützten
ioBroker-Sprachen verfügbar. Logs, Benachrichtigungen und Ergebnisse des
Verbindungstests sind immer auf Englisch. Eine Backend-Sprachauswahl gibt es nicht.

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
| Übersetzungen | `admin/i18n/*/translations.json`, `src/lib/i18n.ts`, `src/lib/states/objectNames.ts` |
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
npm-Paket enthalten sein. Die `files`-Liste in `package.json` steuert den Paketinhalt;
eine `.npmignore` wird dafür nicht verwendet. Vor dem Packen den Build ausführen.

## CI und Release

Pushes auf `main`, Versions-Tags, Pull Requests und manuelle Läufe führen folgende
Prüfungen aus:

- TypeScript und ESLint auf Ubuntu mit Node 24
- anschließend Adaptertests auf Ubuntu, Windows und macOS mit Node 22, 24 und 26

Bei Branch-Pushes überspringt der Pfadfilter reine Markdown-, `docs/`- und
`.vscode/`-Änderungen; für Pull Requests gilt dieser Filter nicht.
Der wöchentliche Spec-Wächter läuft montags und kann manuell gestartet
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
Spec prüfen, die lokale Kopie mit `node tools/check-spec.mjs --update` aktualisieren
und dann `npm run codegen` ausführen. Spec, generierte Typen und Objektdefinitionen
gemeinsam prüfen und versionieren.

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
