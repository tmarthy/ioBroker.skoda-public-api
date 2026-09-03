# Handoff — ioBroker.skoda-public-api

**Stand: 2026-09-03, nach Phase 5.** Auf GitHub, CI grün. Die drei Schichten unter `main.ts` stehen: HTTP-Schicht, QuotaManager, StateWriter. Diese Datei ist der Einstieg für jeden, der die
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
| 2 | Mock-Server, Aufnahmewerkzeug, Fixtures | **fertig** |
| 3 | HTTP-Schicht (`sanitize`, Fehler-Union, Client) | **fertig** |
| 4 | QuotaManager | **fertig** (Anbindung an `info.rateLimit.*` in Phase 6) |
| 5 | StateWriter | **fertig** |
| 6 | PollScheduler → **Meilenstein 1: lesender Adapter** | offen — **als Nächstes** |
| 7 | CommandQueue → **Meilenstein 2: steuernder Adapter** | offen |
| 8–12 | Admin-UI, Schlüsselablauf, Tests/CI, Doku, Release | offen |

Letzter vollständig grüner Lauf (2026-09-03):

```
npm run check            tsc --noEmit, fehlerfrei
npm run lint             0 Fehler, 0 Warnungen
npm run test:ts          201 Tests
npm run test:package     57 Tests
npm run test:integration  1 Test  (startet den Adapter in einer echten ioBroker-Instanz)
npm run build            Type-Check und esbuild fehlerfrei
npm run check:spec       eingecheckte Spec deckungsgleich mit der Live-API
npm run codegen          reproduzierbar (identische Prüfsummen bei erneutem Lauf)
```

Elf Commits auf `main`, gepusht nach
`https://github.com/tmarthy/ioBroker.skoda-public-api` (**privat**).
Nichts ist auf npm veröffentlicht; der Deploy-Job im Release-Workflow ist
auskommentiert, wie `create-adapter` ihn ausliefert.

### Stand der CI

Vier Workflows, alle nachweislich sauber (Lauf 33676066653, keine Annotations):

| Workflow | Auslöser | Stand |
|---|---|---|
| `Test and Release` | Push auf `main`, Tags, PRs | ✓ 7 Jobs: `check-and-lint` plus `adapter-tests` auf Ubuntu, macOS und Windows × Node 22 und 24 |
| `Check Škoda API spec` | **nur** `schedule` (Mo 05:17 UTC) und `workflow_dispatch` | ✓ manuell geprüft, „Spec unveraendert" |
| `Auto-Merge Dependabot PRs` | `pull_request_target` | noch nie gelaufen — wartet auf den ersten Dependabot-PR (monatlich am 21.) |
| Deploy | Tag `v*` | auskommentiert, bis ein `NPM_TOKEN` hinterlegt ist |

**Der Spec-Wächter läuft bei einem Push nicht mit.** Wer ihn nach einer Änderung
prüfen will, muss ihn von Hand auslösen: Actions → *Check Škoda API spec* →
*Run workflow*.

Der `adapter-tests`-Job ist die belastbare Absicherung der `build/`-Umstellung
(siehe Fallstrick 7): Er läuft mit `npm ci` ohne expliziten Build-Schritt, in
sechs OS/Node-Kombinationen. Windows braucht dafür 4–5 Minuten, der Rest gut eine.

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
im Fehler. Der Client liest die Basis-URL deshalb aus `SKODA_API_BASE_URL` und zeigt im
Entwicklungsbetrieb damit auf den Mock:

```bash
SKODA_API_BASE_URL=http://127.0.0.1:8099 npx iobroker-dev-server run default
```

Bewusst nicht in der Admin-UI: Ein sichtbares Feld „API-Server" lädt dazu ein, den
Adapter samt Schlüssel auf einen fremden Host zeigen zu lassen. Eine unbrauchbare URL
fällt beim Erzeugen des Clients auf, nicht erst beim ersten Request.

### Umgebung

- Entwicklung auf macOS, **Node 26**. Produktivsystem ist eine Debian-VM mit **Node 22**.
  Das ist eine bewusste Entscheidung (kein Versionsmanager auf dem Rechner) und in
  `docs/design-decisions.md` als Restrisiko 6 festgehalten: Merkwürdigkeiten im
  `dev-server` erst gegen die Node-Version abgrenzen, bevor man sie als Bug behandelt.
- `engines.node` ist `>= 22`, CI-Matrix 22.x und 24.x.
- `npx iobroker-dev-server run default` startet eine vollständige ioBroker-Instanz unter
  `.dev-server/` (301 MB, gitignoriert), Admin auf Port 8081.

### Zugang zu GitHub

- **`credential.helper` ist ausschließlich lokal in diesem Repo gesetzt** (`osxkeychain`).
  Global ist keiner konfiguriert — andere Repositories fragen den Schlüsselbund also gar
  nicht erst. Genau darin besteht die Abschottung; sie hängt nicht an `useHttpPath`.
  `credential.useHttpPath` war ursprünglich zusätzlich gesetzt und hat den Zugriff
  **blockiert**: Der Eintrag wurde beim ersten Push pfadlos abgelegt, während git nach
  einem pfadgebundenen fragte. Nicht wieder einschalten, ohne den Eintrag neu anzulegen.
- Das Token ist ein **fine-grained PAT**, beschränkt auf dieses eine Repository, mit
  *Contents: Read and write* und *Workflows: Read and write*. Ohne die zweite
  Berechtigung weist GitHub jeden Push zurück, der Dateien unter `.github/workflows/`
  anlegt oder ändert — auch den allerersten.
- `gh` ist eingerichtet (`gh auth status`) und der bequemste Weg, CI-Läufe zu prüfen:
  `gh run list`, `gh run view <id>`, `gh run watch <id> --exit-status`.
  Annotations stehen im `ANNOTATIONS`-Block von `gh run view` — fehlt der Block, gab es
  keine.

---

## 4. Fixtures und was sie über die API verraten

**Nichts blockiert mehr.** Alle vier geplanten Aufnahmen liegen vor.

Nach dem Erzeugen eines API-Schlüssels in der MyŠkoda-App (Version 8.16 oder neuer,
Menüpunkt API-Schlüssel, gebunden an die dort ausgewählten Fahrzeuge):

```bash
export SKODA_API_KEY='...' && export SKODA_VIN='...' && node tools/capture-fixtures.mjs idle "Geparkt, Kabel ab"
```

Vier Aufnahmen sind vorgesehen, jede kostet einen Request aus den 20:

| Name | Zustand des Fahrzeugs | Stand |
|---|---|---|
| `idle` | geparkt, Kabel nicht eingesteckt | vorhanden |
| `plugged` | Kabel dran, lädt nicht | vorhanden |
| `charging` | lädt gerade | vorhanden |
| `climatising` | Klimatisierung läuft | vorhanden |

**Alle vier liegen vor** (2026-09-03). Damit ist Phase 2 vollständig abgeschlossen.
`test/fixtures.test.ts` hält sie fortlaufend gegen das aus der Spec erzeugte Modell —
über alle vier Aufnahmen gab es weder unbekannte Pfade noch unbekannte
Aufzählungswerte noch Typkonflikte. Der Prosa-Parser aus Phase 1 hat also richtig geraten.

#### Was die Aufnahmen über die API verraten

1. **Die tatsächliche Ladeleistung beträgt 5 kW** (`chargePowerInKw: 5`,
   `chargingRateInKilometersPerHour: 31`), nicht die 11 kW, die `maxChargeCurrentAc:
   MAXIMUM` vermuten ließe. Damit ist die offene Frage aus E3 beantwortet: Bang-Bang-
   Überschussladen ist bei diesem Fahrzeug wesentlich brauchbarer als befürchtet. Ob die
   Begrenzung vom Ladeprofil „Zu Hause" (`maxChargingCurrent: REDUCED`) oder vom
   fremden Lademanagement der Bosch-Wallbox kommt, ist damit nicht geklärt — für die
   Auslegung der Regelung zählt die gemessene Zahl.
2. **`isVehicleInSavedLocation` ist als „steht zuhause"-Signal unbrauchbar.** Der Wert
   springt zwischen `true` und `false`, obwohl der Kilometerstand über drei Aufnahmen
   identisch bleibt (30085) und `parkingPosition.state` durchgehend `PARKED` meldet. In
   der Stichprobe korreliert er mit `charging.status.state`, nicht mit dem Ort. **Für
   Geofencing die Koordinaten aus `parkingPosition.gpsCoordinates` verwenden**, nicht
   dieses Flag.
3. **Zeitstempel kommen in unterschiedlicher Genauigkeit** — beobachtet wurden 0, 2, 3
   und **9** Nachkommastellen (`2026-09-03T17:51:16.013958607Z`, Nanosekunden).
   `Date.parse` verkraftet alle und schneidet auf Millisekunden ab. Ein
   **Zeichenketten-Vergleich zweier Zeitstempel ist damit unzuverlässig** — relevant für
   den Frische-Backoff in Phase 6, der `carCapturedTimestamp` über mehrere Polls
   vergleicht: **immer nach Millisekunden parsen.**
4. **Manche Felder erscheinen nur in bestimmten Zuständen:** `chargeType` und
   `chargingRateInKilometersPerHour` nur beim Laden,
   `estimatedReachOfTargetTemperatureAt` nur bei laufender Klimatisierung.
   `fullyChargedAt` und `remainingTimeToFullyChargedInMinutes` tauchen in `idle` mit
   **veralteten Werten aus dem letzten Ladevorgang** auf (Zeitpunkt in der
   Vergangenheit, 0 Minuten) und fehlen in `plugged` ganz. Vorhandensein eines Feldes
   sagt nichts über seine Aktualität.

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
| `src/lib/api/client.ts` | HTTP-Schicht, `ApiResult<T>` samt `meta` | fertig |
| `src/lib/api/errors.ts` | `problem+json` → typisierte Fehler-Union | fertig |
| `src/lib/api/sanitize.ts` | VIN- und Schlüssel-Maskierung | fertig |
| `src/lib/quota/QuotaManager.ts` | Budget, Reserve, `QuotaStore`-Port | fertig |
| `src/lib/states/StateWriter.ts` | JSON → States, `StateApi`-Port | fertig |
| `src/lib/states/commandDefs.ts` | Domäne ↔ Antwortblock, Soll/Ist-Werte | fertig |
| `src/lib/scheduler/PollScheduler.ts` | Kadenz, Frische-Backoff | **Phase 6** |
| `src/lib/commands/CommandQueue.ts` | Soll-Zustand, Coalescing, TTL | Phase 7 |
| `src/main.ts` | noch die Generator-Vorlage, tut nichts | **Phase 6** |

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
9. **GitHub-Actions-Versionen im Blick behalten.** GitHub kündigt Node-Laufzeiten ab und
   meldet das als Warnung an einem sonst grünen Lauf. Zuletzt betroffen:
   `actions/checkout@v4` und `actions/setup-node@v4` (auf `@v5` gehoben). Eine Warnung im
   Job `check-and-lint` stammt **nicht** aus unserem Workflow — der ruft `checkout` gar
   nicht selbst auf —, sondern aus dem Inneren von `ioBroker/testing-action-check`
   (auf `@v2` gehoben). Dependabot pflegt `github-actions` monatlich am 21., spätere
   Sprünge kommen also als geprüfter Pull Request.
10. **`errors` fehlt in einer fehlerfreien Antwort ganz** — die API sendet *kein* leeres
   Array, entgegen dem Beispiel in Škodas eigener Dokumentation. Am 2026-09-02 an einem
   echten Fahrzeug nachgemessen. `body.errors.map(...)` läuft deshalb im Betrieb auf einen
   `TypeError`, obwohl alle Tests grün sind. Immer `body.errors ?? []`. Der generierte Typ
   hat `errors?` bereits als optional, der Compiler erzwingt es also — und der Mock bildet
   das Verhalten seit dieser Messung nach. **Den Mock hier nicht "aufräumen".**
11. **Zwei Dokumente widersprechen sich beim Quota-Verbrauch eines `403`.** Die
   Randbedingungen in `design-decisions.md` sagen pauschal „alle Antworten außer 401,
   403, 429" verbrauchen Quota; die Fehlertabelle in `implementation-plan.md` führt
   `403 operation-not-authorized` als verbrauchend. **Die Fehlertabelle gilt** — so ist
   es umgesetzt, so verhält sich der Mock, und so steht es seit Phase 3 als Fußnote
   unter der Tabelle. Nachgemessen ist es nicht: Dafür bräuchte es einen Befehl, den
   der Nutzer des Schlüssels nicht ausführen darf. Ab Phase 4 sind ohnehin die
   `RateLimit-*`-Header die Quelle der Wahrheit; `consumesQuota` ist nur die Schätzung
   bis zur nächsten Antwort.

---

## 7. Der nächste Schritt

**Phase 6 — PollScheduler. Das ist Meilenstein 1: der lesende Adapter.** Damit fällt
auch die Verdrahtung in `main.ts` an, die bisher bewusst unangetastet blieb — die
Generator-Vorlage tut noch nichts.

| Zustand | Intervall |
|---|---|
| Basis | 15 min (konfigurierbar, Untergrenze 5) |
| Aktiv (`CHARGING` oder Klima ≠ `OFF`) | 5 min (Untergrenze 3) |
| Nach Befehl | ein Verifikations-Poll nach 60 s, danach 10 min aktive Kadenz |
| Frische-Backoff | Verdoppelung bei unverändertem `carCapturedTimestamp`, Deckel 60 min |

Der **Frische-Backoff ist der größte Einzelhebel**: Ein schlafendes Auto liefert bei
jedem Poll denselben Zeitstempel — schneller zu pollen bringt null Information und
kostet volles Budget. Der Vergleich läuft über `Date.parse`, nie über die Zeichenkette
(0 bis 9 Nachkommastellen, Abschnitt 4). Ändert sich der Zeitstempel, sofort zurück auf
Basis.

Erster Poll **ohne** `include` — das ist die Fähigkeitserkennung (E13) —, danach mit der
gelernten Liste, abzüglich `parkingPosition`, falls abgeschaltet (E14). Bei mehreren
VINs reihum aus demselben Bucket (E9).

**Fertig, wenn:** Der Adapter läuft gegen den Mock über eine simulierte Stunde, bleibt
unter 20 Requests, füllt den Objektbaum und drosselt sich beim schlafenden Auto messbar
herunter.

### Was bei der Verdrahtung mitzunehmen ist

Zwei Enden warten in `main.ts` auf ihren Anschluss — beide sind klein, beide fallen
sonst hinten runter:

1. **`QuotaStore` auf `info.rateLimit.*`.** Der QuotaManager persistiert über eine
   Schnittstelle mit `load()`/`save()` (`limit`, `remaining`, `resetAt`,
   `lastRequestAt`). Ohne die Umsetzung greift die Sperrfrist gegen die
   Neustartschleife **nicht** — und genau die verbrennt sonst 20 Requests in
   90 Sekunden.
2. **`StateApi` auf die Adapter-Instanz.** Der StateWriter erwartet vier Methoden plus
   Logger; ein Test beweist bereits zur Übersetzungszeit, dass `ioBroker.Adapter` sie
   erfüllt. `new StateWriter({ api: this })` genügt.

Dazu die Instanzkonfiguration: `main.ts` liest noch `option1`/`option2` aus der
Generator-Vorlage. Die echten Felder kommen in Phase 8 — bis dahin reichen Konstanten
oder ein vorgezogener `native`-Block.

### Was aus Phase 5 zu wissen ist

- **Der Objektbaum entsteht nur aus dem, was in der Antwort steht** (E13). Es gibt kein
  Vorab-Anlegen und **kein Löschen**. Der Snapshot-Test hält den Baum der echten
  Aufnahme als Liste von 76 Objekten fest — wer den Writer ändert, sieht dort sofort,
  was dazukommt oder verschwindet.
- **Fehlende Teile behalten ihren Wert und bekommen das Quality-Flag** `0x01` (E8).
  Markiert wird nur, was die API in `errors[]` gemeldet hat; ein per `include` nicht
  angefordertes Teil gilt nicht als gestört. Kommt es zurück, hebt ein unbedingtes
  `setState` die Markierung wieder auf.
- **Die Befehls-States entstehen aus derselben Fähigkeitserkennung** (E15):
  `<vin>.<block>.enabled` als Soll-Schalter, `.start` und `.stop` als Knöpfe — aber nur
  für Blöcke, die in der Antwort stehen. Für diesen Enyaq sind das `charging` und
  `airConditioning`, nicht `auxiliaryHeating` und `activeVentilation`.
- Der Writer schreibt `enabled` mit `ack: true` (das ist der Ist-Zustand). Was ein
  Nutzer mit `ack: false` hineinschreibt, ist der Soll-Zustand und Sache der
  CommandQueue in Phase 7. `commandDefs.ts` trägt dafür bereits die Zuordnung Domäne ↔
  Block samt der Werte, bei denen `enabled` true ist.
- **Unbekannte Pfade werden angelegt, nicht verworfen** — mit geratenem Typ, `role:
  'state'` und genau einer Warnung. Sie sind der Hinweis, dass Skoda die Spec erweitert
  hat und `npm run codegen` fällig ist. Die Warnung enthält keine VIN (E14).

### Was aus Phase 4 zu wissen ist

- **Der Ablauf ist immer derselbe:** `tryAcquire('poll' | 'command')` fragen, bei `ok`
  den Request absetzen, danach **immer** `recordResponse(result.meta)` melden — auch im
  Fehlerfall. Wer das auslässt, blockiert den Platz dauerhaft.
- Eine Ablehnung liefert `waitMs` und `reason`: `reserve` (nur noch die Befehlsreserve
  übrig, gilt nur für Polls), `exhausted` (Budget leer) oder `startup-guard`
  (Sperrfrist nach dem Neustart, drei Minuten seit dem letzten Request).
- **Der Manager rechnet nicht mit, er glaubt den Headern.** `remaining` wird nur aus
  einer Antwort gesetzt; `snapshot().confirmed` sagt, ob die Zahl bestätigt oder
  geschätzt ist. Nur ohne Header (Netzwerkfehler) zählt er selbst herunter.
- Polls stoppen bei `remaining <= commandReserve` (Vorgabe 6), Befehle laufen bis 0.
  Gegen den Mock heißt das: 14 Polls, dann hält der Adapter von selbst an — die API
  muss nie mit `429` antworten.

### Was aus Phase 3 zu wissen ist

- **Jede Meldung ist maskiert.** `sanitize()` läuft über alles, was `errors.ts` und
  `client.ts` erzeugen. Wer eine eigene Meldung baut, die eine URL, eine VIN oder den
  Schlüssel enthalten könnte, nimmt `createSanitizer()` — nie eine rohe URL.
- **`vehicleErrors(response)`** ist die einzige Stelle, die `errors ?? []` umsetzt
  (Fallstrick 10). Der Client normalisiert die Antwort nicht; der optionale Typ bleibt
  als Wächter stehen.
- **Die beiden `429` unterscheiden sich nur am `type`**, nicht am Status und nicht an
  den `RateLimit-*`-Headern: `rate-limit-exceeded` darf geduldig warten
  (`maxRetries: Infinity`, begrenzt durch die TTL des Befehls),
  `vehicle-not-accepting-requests` kommt vom Auto und höchstens dreimal.
- **`unexpected`** ist der Auffangfall für alles, was in keine Zeile der Tabelle passt
  (`about:blank` bei `401`, ein `200` ohne `vehicle`, HTML von einem Proxy). Er wird nie
  wiederholt.

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
