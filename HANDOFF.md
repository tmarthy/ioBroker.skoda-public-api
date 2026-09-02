# Handoff — ioBroker.skoda-public-api

**Stand: 2026-09-02, nach Phase 2, erste echte Aufnahme vorhanden.** Diese Datei ist der Einstieg für jeden, der die
Arbeit übernimmt oder nach einer Pause wieder aufnimmt. Sie beschreibt, wo das Projekt
steht, was als Nächstes ansteht und welche Fallstricke bereits bekannt sind.

Die beiden anderen Dokumente:

- [`docs/design-decisions.md`](docs/design-decisions.md) — **das Warum.** 16 Entwurfs-
  entscheidungen (E1–E16) mit Begründung, dazu die harten Randbedingungen der API und
  sechs benannte Restrisiken. Wer eine Entscheidung umdrehen will, liest zuerst dort.
- [`docs/implementation-plan.md`](docs/implementation-plan.md) — **das Wie.** Zwölf Phasen
  mit Abnahmekriterien, Abhängigkeitsgraph und der verbindlichen Fehlertabelle.

---

## 1. Worum es geht

Ein ioBroker-Adapter für die **offizielle MyŠkoda Public API**, der einen Škoda Enyaq
ausliest und steuert. Nicht zu verwechseln mit `iobroker.vw-connect`, das dieselben
Fahrzeuge über die reverse-engineerte App-Schnittstelle anspricht.

**Die eine Zahl, die alles bestimmt: 20 Requests pro Stunde und API-Schlüssel.**
Wer das vergisst, entwirft am Problem vorbei. Ein Poll alle drei Minuten verbraucht das
gesamte Budget; ein Befehl kostet realistisch zwei bis drei Requests, weil der POST mit
`202 Accepted` antwortet und es keinen Endpunkt gibt, der den Ausgang meldet.

Weitere Randbedingungen, die man kennen muss, bevor man Code schreibt:

| Eigenschaft | Wert |
|---|---|
| Authentifizierung | statischer `X-API-Key` aus der MyŠkoda-App, mit Ablaufdatum |
| Lese-Endpunkte | genau einer: `GET /api/v1/vehicles/{vin}` |
| Schreib-Endpunkte | 8 POSTs (Laden, Klima, Standheizung, Lüftung — je start/stop) |
| Quota-Verbrauch | alle Antworten **außer** 401, 403, 429 |
| Fahrzeugliste | **existiert nicht** — die VIN wird konfiguriert, nicht entdeckt |
| Push/Webhooks | keine |
| Spec-Version | `v0`, laut Dokumentation ausdrücklich änderbar |

Nicht möglich, weil die API es nicht anbietet: Ver-/Entriegeln, Hupe, Ladestrom setzen,
Ziel-SoC setzen, Ladeprofile ändern, Schlüssel automatisch erneuern.

---

## 2. Wo das Projekt steht

| Phase | Inhalt | Stand |
|---|---|---|
| 0 | Projektgerüst, dev-server | **fertig** |
| 1 | Spec, Codegen, Spec-Wächter | **fertig** |
| 2 | Mock-Server, Aufnahmewerkzeug | **fertig**, echte Fixtures offen |
| 3 | HTTP-Schicht (`sanitize`, Fehler-Union, Client) | offen — **als Nächstes** |
| 4 | QuotaManager | offen |
| 5 | StateWriter | offen |
| 6 | PollScheduler → **Meilenstein 1: lesender Adapter** | offen |
| 7 | CommandQueue → **Meilenstein 2: steuernder Adapter** | offen |
| 8–12 | Admin-UI, Schlüsselablauf, Tests/CI, Doku, Release | offen |

Letzter vollständig grüner Lauf (2026-09-01):

```
npm run check          tsc --noEmit, fehlerfrei
npm run lint           0 Fehler, 0 Warnungen
npm run test:ts        41 Tests
npm run test:package   57 Tests
npm run build          Type-Check und esbuild fehlerfrei
npm run check:spec     eingecheckte Spec deckungsgleich mit der Live-API
npm run codegen        reproduzierbar (identische Prüfsummen bei erneutem Lauf)
```

Fünf Commits auf `main`, kein Remote konfiguriert. Nichts ist veröffentlicht.

---

## 3. Sofort loslegen

```bash
npm install
npm run mock
```

Der Mock läuft dann auf `http://127.0.0.1:8099` und antwortet auf

```bash
curl -H "X-API-Key: mock-api-key" http://127.0.0.1:8099/api/v1/vehicles/TMBJB9NY5RF999999
```

Szenario im laufenden Betrieb umschalten:

```bash
curl 'http://127.0.0.1:8099/__mock/scenario?value=rate-limit-exceeded'
```

Gültige Werte: `ok`, `partial-data`, `api-key-expired`, `api-key-not-authorized`,
`operation-not-authorized`, `operation-not-supported`, `operation-disabled`,
`rate-limit-exceeded`, `vehicle-not-accepting-requests`, `not-found`, `server-error`,
`service-unavailable`, `gateway-timeout`. Dazu `/__mock/reset`, `/__mock/fixture?value=…`
und `/__mock` für den aktuellen Zustand.

**Gegen die echte API lässt sich nicht entwickeln.** 20 Requests sind nach zwanzig
Minuten Debugging aufgebraucht, und danach sitzt man bis zur vollen Stunde fest — mitten
im Fehler. Vorgesehen ist, dass der Adapter die Basis-URL aus `SKODA_API_BASE_URL`
liest und im Entwicklungsbetrieb damit auf den Mock zeigt — **umgesetzt wird das erst in
Phase 3** zusammen mit dem Client. Bewusst nicht in der Admin-UI: Ein sichtbares Feld
„API-Server" lädt dazu ein, den Adapter samt Schlüssel auf einen fremden Host zeigen zu
lassen.

### Umgebung

- Entwicklung auf macOS, **Node 26**. Produktivsystem ist eine Debian-VM mit **Node 22**.
  Das ist eine bewusste Entscheidung (kein Versionsmanager auf dem Rechner) und in
  `docs/design-decisions.md` als Restrisiko 6 festgehalten: Merkwürdigkeiten im
  `dev-server` erst gegen die Node-Version abgrenzen, bevor man sie als Bug behandelt.
- `engines.node` ist `>= 22`, CI-Matrix 22.x und 24.x.
- `npx iobroker-dev-server run default` startet eine vollständige ioBroker-Instanz unter
  `.dev-server/` (301 MB, gitignoriert), Admin auf Port 8081.

---

## 4. Was gerade blockiert

**Die echten Fixtures. Dafür wird das Fahrzeug gebraucht.** Alles andere läuft weiter.

Nach dem Erzeugen eines API-Schlüssels in der MyŠkoda-App (Version 8.16 oder neuer,
Menüpunkt API-Schlüssel, gebunden an die dort ausgewählten Fahrzeuge):

```bash
export SKODA_API_KEY='...' && export SKODA_VIN='...' && node tools/capture-fixtures.mjs idle "Geparkt, Kabel ab"
```

Vier Aufnahmen sind vorgesehen, jede kostet einen Request aus den 20:

| Name | Zustand des Fahrzeugs |
|---|---|
| `idle` | geparkt, Kabel nicht eingesteckt |
| `plugged` | Kabel dran, lädt nicht |
| `charging` | lädt gerade |
| `climatising` | Klimatisierung läuft |

Das Werkzeug ersetzt VIN, Kennzeichen, Fahrzeugname, Adresse und Koordinaten durch
Beispielwerte und **bricht ab, falls danach noch eine Spur der echten VIN oder des
Schlüssels in der Datei steht.** Schlüssel und VIN erscheinen in keiner Ausgabe. Nebenbei
meldet es den Budgetstand und das Ablaufdatum des Schlüssels.

`test/fixtures/vehicle-idle.json` ist die erste echte Aufnahme (2026-09-02) und der
Standard des Mocks. `vehicle-synth-idle.json` bleibt daneben als Fahrzeug mit vollem
Funktionsumfang: Es enthält absichtlich Felder, die dieser Enyaq **nicht** liefert, damit
auch deren Code-Pfade getestet werden.

#### Was dieser Enyaq tatsächlich liefert

Gemessen am 2026-09-02, nicht aus der Spec abgeleitet:

| Teil | vorhanden |
|---|---|
| `status`, `odometer`, `parkingPosition` | ja |
| `airConditioning`, `charging`, `chargingProfiles` | ja |
| `fuelStatus` | nein — BEV |
| `auxiliaryHeating` | nein |
| `activeVentilation` | **nein** |

**Damit sind von den acht Befehlsendpunkten nur vier nutzbar:** `charging/start`,
`charging/stop`, `air-conditioning/start`, `air-conditioning/stop`. Standheizung und
aktive Belüftung fallen für dieses Fahrzeug weg — die Fähigkeitserkennung aus E13/E15
legt die zugehörigen Zustände gar nicht erst an.

Auch **innerhalb** vorhandener Blöcke fehlen Felder: `charging.status.chargeType`,
`charging.settings.maxChargeCurrentAcAmpere`,
`airConditioning.airConditioningWithoutExternalPower`,
`chargingProfiles.currentVehiclePositionProfile` und
`minBatteryStateOfCharge.enabled` waren allesamt nicht in der Antwort. Optionalität gilt
auf jeder Ebene, nicht nur für die grossen Blöcke.

---

## 5. Architektur in einem Bild

Vier Schichten, strikt getrennt. **Kein Request verlässt den Adapter, ohne den
QuotaManager passiert zu haben** — weder der Scheduler noch die CommandQueue rufen den
Client direkt auf.

```
         ioBroker (States, Admin-UI, Skripte des Nutzers)
                        |            ^
             Befehle    v            |   States
         +--------------------------------------------+
         |  main.ts   Lifecycle, Verdrahtung           |
         +--------------------------------------------+
         |  CommandQueue        |     StateWriter      |   Schicht 4
         +--------------------------------------------+
         |  PollScheduler       |                      |   Schicht 3
         +--------------------------------------------+
         |  QuotaManager  (ein Bucket pro Instanz)     |   Schicht 2
         +--------------------------------------------+
         |  SkodaApiClient  (fetch, Header, sanitize)  |   Schicht 1
         +--------------------------------------------+
                        |
              Škoda Public API  /  Mock-Server
```

### Dateikarte

| Pfad | Rolle | Stand |
|---|---|---|
| `spec/skoda-openapi.json` | eingecheckte OpenAPI-Spec, Quelle des Codegens | fertig |
| `tools/spec.mjs` | Spec laden, bekannte Spec-Fehler entfernen | fertig |
| `tools/generate-types.mjs` | → `src/lib/api/schema.generated.ts` | fertig |
| `tools/generate-objectdefs.mjs` | → `src/lib/states/objectDefs.generated.ts` | fertig |
| `tools/check-spec.mjs` | Live-Spec gegen eingecheckte Kopie | fertig |
| `tools/capture-fixtures.mjs` | Aufnahme am Fahrzeug, anonymisiert | fertig |
| `src/lib/api/types.ts` | lesbare Aliase, **einziger** Zugang zum Generat | fertig |
| `src/lib/api/parts.ts` | Antwortteil ↔ Fehlertyp (`CHARGING_UNAVAILABLE` …) | fertig |
| `src/lib/states/objectDefs.generated.ts` | 76 Zustände, 21 Kanäle, 27 Aufzählungen | fertig |
| `src/lib/states/objectOverlay.ts` | Rollen, Einheiten, Labels; `resolveCommon()` | fertig |
| `test/mock/server.ts` | Mock der API, 13 Szenarien | fertig |
| `test/mock/cli.ts` | Standalone-Betrieb, `npm run mock` | fertig |
| `src/lib/api/client.ts` | HTTP-Schicht | **Phase 3** |
| `src/lib/api/errors.ts` | `problem+json` → typisierte Fehler-Union | **Phase 3** |
| `src/lib/api/sanitize.ts` | VIN- und Schlüssel-Maskierung | **Phase 3** |
| `src/lib/quota/QuotaManager.ts` | Budget, Reserve, Persistenz | Phase 4 |
| `src/lib/states/StateWriter.ts` | JSON → States | Phase 5 |
| `src/lib/scheduler/PollScheduler.ts` | Kadenz, Frische-Backoff | Phase 6 |
| `src/lib/commands/CommandQueue.ts` | Soll-Zustand, Coalescing, TTL | Phase 7 |
| `src/main.ts` | noch die Generator-Vorlage, tut nichts | Phase 6 |

---

## 6. Bekannte Fallstricke

Alles hier ist bereits passiert und behoben. Die Liste steht da, damit niemand ein
zweites Mal hineinläuft oder eine Korrektur versehentlich zurückdreht.

1. **Die Spec enthält Fehler.** `Charging` und `ChargingProfile` haben je ein Feld
   `tings`, das rekursiv auf den eigenen Typ zeigt — offensichtlich ein abgeschnittenes
   `settings` aus Škodas Generator. `tools/spec.mjs` entfernt beide vor dem Codegen;
   ohne das entsteht eine unendliche Typrekursion. Sollte Škoda das beheben, meldet das
   Werkzeug es als Hinweis und bricht **nicht** ab.
2. **Aufzählungen stehen nicht als `enum` in der Spec**, sondern in Prosa — in vier
   verschiedenen Formaten. `tools/generate-objectdefs.mjs` parst alle vier. Beim
   Erweitern der Spec unbedingt prüfen, ob der Parser die neuen Werte findet: Er ist
   bewusst streng und liefert im Zweifel **nichts** statt etwas Falsches.
3. **`@tsconfig/node22` setzt `"types": ["node"]`** und blendet damit die Mocha-Typen
   aus. `tsconfig.json` überschreibt das auf `["node", "mocha"]`. Ohne diese Zeile ist
   `npm run check` rot — so kam das Projekt aus dem Generator.
4. **`eslint --fix` fügt leere JSDoc-Blöcke ein**, die eine zweite Regel sofort wieder
   anmeckert (`require-jsdoc` gegen `no-blank-blocks`). Nach jedem `--fix` prüfen, ob
   leere `/** */`-Blöcke entstanden sind, und sie mit Inhalt füllen.
5. **`f(a, undefined)` greift auf den Vorgabewert zurück.** In einem Test hieß das:
   „ohne API-Schlüssel anfragen" schickte den gültigen Schlüssel mit, und der Test war
   aus dem falschen Grund grün. In `test/mock/server.test.ts` ist `null` das Signal für
   „kein Header".
6. **Die Übersetzungsautomatik interpretiert die Vorlage als Englisch.** Eine deutsche
   Beschreibung in `io-package.json` erzeugte Unsinn in neun Sprachen. Ausgangssprache
   ist Englisch, Deutsch wird von Hand gesetzt, der Rest maschinell daraus.
   `titleLang` bleibt in allen Sprachen `Škoda Public API` — ein Produktname wird nicht
   übersetzt.
7. **`build/` ist bewusst *nicht* versioniert** — abweichend von der Generator-Vorgabe
   für TypeScript-Adapter. Stattdessen erzeugt das `prepare`-Skript das Kompilat
   überall dort, wo es gebraucht wird: bei `npm ci` in der CI, bei `npm install` in der
   Entwicklung, bei `npm pack`/`npm publish` und bei einer Installation über eine
   git-URL. Beides ist nachgemessen. **`build/` nicht wieder einchecken** — es würde bei
   jeder Änderung an `src/` einen zweiten Diff erzeugen.
   Einzige verbliebene Lücke: Eine Installation direkt aus einem GitHub-*Tarball*
   (statt über npm oder eine git-URL) führt `prepare` nicht aus und bekäme kein
   Kompilat. Der übliche Weg `iob url …` installiert über eine git-URL und ist davon
   nicht betroffen.
8. **Generierte Dateien sind von ESLint und Prettier ausgenommen** (`src/**/*.generated.ts`).
   Nicht wieder einschließen — das erzeugt 738 Formatierungsfehler.
9. **`errors` fehlt in einer fehlerfreien Antwort ganz** — die API sendet *kein* leeres
   Array, entgegen dem Beispiel in Škodas eigener Dokumentation. Am 2026-09-02 an einem
   echten Fahrzeug nachgemessen. `body.errors.map(...)` läuft deshalb im Betrieb auf einen
   `TypeError`, obwohl alle Tests grün sind. Immer `body.errors ?? []`. Der generierte Typ
   hat `errors?` bereits als optional, der Compiler erzwingt es also — und der Mock bildet
   das Verhalten seit dieser Messung nach. **Den Mock hier nicht "aufräumen".**

---

## 7. Der nächste Schritt

**Phase 3 — HTTP-Schicht.** Braucht das Fahrzeug nicht und kann sofort beginnen.

- `src/lib/api/sanitize.ts` — ersetzt VIN (`[A-HJ-NPR-Z0-9]{17}`) und API-Schlüssel in
  **jeder** Meldung durch Platzhalter. Grund: Die VIN steht im URL-Pfad, und
  ioBroker-Logs landen routinemäßig als Copy-Paste im Forum. Zusammen mit
  `formattedAddress` ergäbe das die Heimatadresse im Klartext. **Nie eine Fehlermeldung
  aus einer rohen URL bauen.**
- `src/lib/api/errors.ts` — `application/problem+json` in eine diskriminierte Union.
  Jeder Fall trägt `retryable`, `consumesQuota` und `retryAfterMs`; die verbindliche
  Zuordnung steht in `docs/implementation-plan.md`, Abschnitt „Fehlerbehandlung".
- `src/lib/api/client.ts` — `getVehicle(vin, include?)` und
  `sendCommand(vin, domain, action, body?)`, native `fetch`, `AbortSignal.timeout()`,
  liest `RateLimit-*` und `X-API-Key-Expires-At` aus jeder Antwort.

**Abnahmekriterium:** Unit-Tests decken jede Zeile der Fehlertabelle ab, und ein Test
prüft explizit, dass in keiner erzeugten Meldung VIN oder Schlüssel auftauchen.

Der Mock aus Phase 2 liefert alle nötigen Fälle bereits auf Kommando — die Tests der
HTTP-Schicht laufen gegen ihn, nicht gegen Fixtures allein.

---

## 8. Was bewusst nicht gebaut wird

Damit niemand es „nachrüstet" und dabei eine Entscheidung überschreibt:

- **Keine PV-Regellogik im Adapter.** Hysterese, Schwellen und Mindestlaufzeiten gehören
  in ein ioBroker-Skript; eine Vorlage kommt nach `examples/pv-surplus-charging.js`.
  Die **Quota-Verwaltung** bleibt dagegen im Adapter, sonst baut jedes Skript sie neu.
- **Keine mehrfachen API-Schlüssel pro Instanz** zur Vervielfachung der Quota.
- **Kein Kurz-Alias-Kanal.** Wer kürzere IDs will, nutzt `alias.0.*` — das kann ioBroker
  nativ.
- **Keine automatische Schlüsselrotation.** Technisch unmöglich; der Ablauf wird
  stattdessen über das ioBroker-Notification-System gemeldet (E10).
