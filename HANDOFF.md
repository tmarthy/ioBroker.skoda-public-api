# Handoff — ioBroker.skoda-public-api

**Stand: 2026-09-04, nach Phase 12.** Auf GitHub. Die CI kann derzeit keine Jobs starten (Abrechnung des GitHub-Kontos, siehe Abschnitt 2); der letzte vollständige Lauf liegt vor der Umstellung der Matrix. Der Adapter liest, steuert und meldet den Ablauf seines Schlüssels; die Admin-UI ist vollständig. Der Lebenslauf einer Instanz — Poll, Objektbaum, Befehl, Verbindungstest, Neustart mitten im Quota-Fenster, abgelaufener Schlüssel — läuft seit Phase 10 als Integrationstest gegen den Mock, in einer echten ioBroker-Instanz. Diese Datei ist der Einstieg für jeden, der die
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
| 4 | QuotaManager | **fertig** |
| 5 | StateWriter | **fertig** |
| 6 | PollScheduler, Verdrahtung → **Meilenstein 1: lesender Adapter** | **fertig** |
| 7 | CommandQueue → **Meilenstein 2: steuernder Adapter** | **fertig** |
| 8 | Admin-UI, Verbindungstest, Übersetzungen | **fertig** |
| 9 | Schlüsselablauf und Notifications | **fertig** |
| 10 | Tests und CI vervollständigen | **fertig** |
| 11 | Beispielskript und Dokumentation | **fertig** |
| 12 | Release-Vorbereitung | **fertig bis auf die Entscheidung aus E1** |

Letzter vollständig grüner Lauf (2026-09-04):

```
npm run check            tsc --noEmit, fehlerfrei
npm run lint             0 Fehler, 0 Warnungen
npm run test:unit        317 Tests  (auch als "test:ts")
npm run test:package     57 Tests
npm run test:integration  7 Tests  (echte ioBroker-Instanz gegen den Mock, ~11 min)
npm run build            Type-Check und esbuild fehlerfrei
npm run check:spec       eingecheckte Spec deckungsgleich mit der Live-API
npm run codegen          reproduzierbar (identische Prüfsummen bei erneutem Lauf)
```

Elf Commits auf `main`, gepusht nach
`https://github.com/tmarthy/ioBroker.skoda-public-api` (**privat**).
Nichts ist auf npm veröffentlicht; der Deploy-Job im Release-Workflow ist
auskommentiert, wie `create-adapter` ihn ausliefert.

### Stand der CI

Vier Workflows. **Seit dem 2026-09-04 startet GitHub keine Jobs mehr**: „recent account
payments have failed or your spending limit needs to be increased". Kein Job hat dabei
auch nur einen Schritt ausgeführt — es ist kein Fehler am Code. Bis das geklärt ist,
gilt der lokale Lauf als Nachweis (`npm run check`, `lint`, `test`, `test:integration`,
`build`).

**Die Matrix ist gestaffelt, und zwar aus Kostengründen.** GitHub rechnet Linux
einfach, Windows doppelt und **macOS zehnfach** ab. Mit der vollen Matrix kostete ein
einziger Push rund **385 abgerechnete Minuten** — bei 2000 Freiminuten im Monat sind
das fünf Pushes. Deshalb:

| Anlass | Was läuft | Kosten |
|---|---|---|
| Push, Pull Request | `check-and-lint` + `adapter-tests` auf **Ubuntu** × Node 22/24 | ~40 min |
| Versions-Tag (`v*`) | zusätzlich Windows und macOS | ~385 min |
| `workflow_dispatch` mit `full_matrix` | dasselbe auf Zuruf | ~385 min |

Dazu: `paths-ignore` für `**.md` und `docs/**` (reine Dokumentations-Pushes lösen
nichts aus), `[skip ci]` in der Commit-Nachricht wirkt weiterhin, und **jeder Job hat
jetzt ein `timeout-minutes`**. Ohne das läuft ein hängender Job bis zum GitHub-Standard
von sechs Stunden — auf macOS wären das 3600 abgerechnete Minuten aus einem einzigen
Versehen.

| Workflow | Auslöser | Stand |
|---|---|---|
| `Test and Release` | Push auf `main`, Tags, PRs, `workflow_dispatch` | ✓ Ubuntu × Node 22/24; volle Matrix nur bei Tags oder auf Zuruf |
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

**Der Adapter als Ganzes** läuft im Integrationstest — drei Suites in einer echten
ioBroker-Instanz gegen den Mock, rund elf Minuten:

```bash
npm run test:integration
```

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

**Die Instanz konfigurieren:** API-Schlüssel und VIN gehören in die Admin-UI
(`http://localhost:8081` → Instanzen → Skoda Public API). Der Schlüssel steht unter
`encryptedNative` — **nicht im Objektbrowser eintragen**, dort landet er im Klartext
und wird beim Start als verschlüsselt behandelt (Fallstrick 12). Gegen den Mock sind
das `mock-api-key` und `TMBJB9NY5RF999999`.

**Der ganze Ablauf, einmal durchgespielt** (2026-09-04, hat funktioniert):

```bash
npm run mock &                                    # Mock auf 127.0.0.1:8099
SKODA_API_BASE_URL=http://127.0.0.1:8099 npx iobroker-dev-server run default

# Nach jeder Änderung an src/ oder admin/ (siehe Fallstrick 14):
npm pack
cd .dev-server/default
npm install ../../iobroker.skoda-public-api-0.0.1.tgz
./iob upload skoda-public-api        # bringt admin/ und io-package.json in die DB
./iob restart skoda-public-api.0
```

Danach im Admin den Schlüssel eintragen, speichern, Instanz starten. Beobachtet wurden:
`info.connection = true`, der volle Objektbaum unter der VIN, `info.rateLimit.*` mit
dem gebuchten Budget, ein Befehl über `charging.enabled` mit `info.lastCommand.result
= SENT` und dem Verifikations-Poll 60 Sekunden später (`charging.status.state` springt
auf `CHARGING`) — und nach einem Neustart **kein** sofortiger Poll, weil die Sperrfrist
des QuotaManagers greift.

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
| `src/lib/api/vehicleData.ts` | `newestCapturedAt()`, `detectParts()` | fertig |
| `src/lib/config.ts` | Instanzkonfiguration prüfen und umrechnen | fertig |
| `src/lib/quota/AdapterQuotaStore.ts` | Quota-Zustand in `info.rateLimit.*` | fertig |
| `src/lib/scheduler/PollScheduler.ts` | Kadenz, Frische-Backoff, `include` | fertig |
| `test/helpers/fakeAdapter.ts` | Adapter-Doppel für die Tests | fertig |
| `src/lib/commands/CommandQueue.ts` | Soll-Zustand, Coalescing, TTL (E5) | fertig |
| `src/lib/commands/commandMap.ts` | State-ID → Endpunkt + Body-Builder | fertig |
| `src/lib/connectionTest.ts` | „Verbindung testen" der Admin-UI | fertig |
| `src/lib/notifications/keyExpiry.ts` | Schlüsselablauf: Schwellen 14/7/2 (E10) | fertig |
| `src/main.ts` | Lifecycle, Verdrahtung der vier Schichten | fertig |
| `examples/pv-surplus-charging.js` | Bang-Bang-Vorlage für den JavaScript-Adapter | fertig |

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
12. **Der API-Schlüssel steht unter `encryptedNative`.** js-controller entschlüsselt
   ihn beim Start — ein von Hand im Objektbrowser eingetragener Klartextwert wird
   dabei zu Unsinn und die API antwortet mit `403`. Schlüssel und S-PIN deshalb
   ausschließlich über die Admin-UI setzen. Ein Test, der eine Instanz selbst
   konfiguriert (Phase 10), muss den Wert mit dem Systemschlüssel aus `system.config`
   verschlüsseln.
13. **`common.messagebox: true` in `io-package.json` ist Pflicht, sobald ein `sendTo`
   im Spiel ist.** Ohne die Kennzeichnung stellt js-controller die Nachricht gar nicht
   erst zu: Der „Verbindung testen"-Knopf dreht sich bis zum Timeout — keine
   Fehlermeldung, keine Logzeile, nichts. Kein Unit-Test hätte das gezeigt; gefunden
   hat es erst der Versuch in einer echten Instanz.
14. **`iobroker-dev-server upload` ist in diesem Repo kaputt** — als Folge von
   Fallstrick 7. Das Werkzeug liest den Namen des Pakets aus der Ausgabe von
   `npm pack`, und unser `prepare`-Skript schreibt genau dort den Build-Fortschritt
   hinein; `npm` sucht die Datei dann unter „> iobroker.skoda-public-api@0.0.1
   prepare" und bricht mit `ENOENT` ab. Der Weg von Hand steht in Abschnitt 3.
   Dazu gehört: **Der dev-server hält eine Kopie des Adapters, keinen Symlink**, und
   `dev-server run` frischt sie nicht auf.
15. **Die CI ruft `npm run test:unit`, nicht `test:ts`.** Fehlt das Skript,
   überspringt der Job die Unit-Tests **stillschweigend** — bis Phase 10 liefen die
   317 Tests deshalb ausschließlich lokal. Wer ein Testskript umbenennt, nimmt der CI
   womöglich die Tests weg, ohne dass etwas rot wird. `test:ts` ist heute nur noch ein
   Alias auf `test:unit`.
16. **Ein Integrations-Testaufbau lässt sich genau einmal starten** („This test harness
   has already been used"). Ein Neustart innerhalb eines Tests geht nicht; jeder
   Lebenslauf braucht eine eigene `suite`. Ein Neustart wird deshalb nachgestellt,
   indem der Zustand des Vorgängers vor dem Start in `info.rateLimit.*` liegt.
   Zwei weitere Eigenheiten dort: `common.messagebox` kommt über `iobroker add`
   **nicht** ins Instanzobjekt (über `iobroker upload` schon, siehe Fallstrick 13), und
   `info.connection` steht bereits, **bevor** der Objektbaum geschrieben ist — als
   Synchronisationspunkt für Zustände taugt es deshalb nicht.

---

## 7. Der nächste Schritt

**Alle zwölf Phasen sind abgearbeitet.** Was bleibt, ist keine Programmieraufgabe,
sondern eine Entscheidung — die aus E1: **Wird der Adapter eingereicht, oder bleibt er
privat?** Daran hängt der Rest.

### Bleibt er privat

Dann ist nichts weiter zu tun. Der Adapter läuft, ist getestet und dokumentiert. Vor dem
ersten Dauerbetrieb fällig:

- **Auf dem Produktivsystem laufen lassen** (Debian-VM, Node 22) und ein paar Tage am
  echten Fahrzeug beobachten. Alles bisher Gemessene stammt vom Mock oder aus vier
  Aufnahmen. Besonders im Auge behalten: die Kadenz über einen ganzen Tag (schläft das
  Auto so, wie der Backoff annimmt?) und das erste `429`.
- `npm run release` interaktiv laufen lassen, wenn eine Version gesetzt werden soll. Der
  Trockenlauf ist durch: `check:git`, `check:package`, `check:changelog` und
  `check:iobroker` melden alle „ok"; danach fragt das Skript nach der Versionsnummer —
  bewusst eine Handentscheidung.

### Wird er eingereicht

Dann kommt dazu:

1. **Repository öffentlich machen.** Der Adapter-Checker arbeitet über die GitHub-API
   und sieht ein privates Repo nicht; erst danach lässt er sich überhaupt ausführen.
2. **Sprache vereinheitlichen.** Heute sind Logmeldungen, Notification-Texte und der
   Verbindungstest deutsch, README und Admin-Labels englisch. Für eine Einreichung
   erwartet man Englisch durchgehend — das betrifft rund 40 Zeichenketten in
   `client.ts`, `errors.ts`, `PollScheduler.ts`, `CommandQueue.ts`, `keyExpiry.ts`,
   `connectionTest.ts`, `config.ts` und `main.ts`.
3. **npm einrichten:** Trusted Publishing im npm-Konto, danach den `deploy`-Job im
   Workflow einkommentieren.
4. **Sentry entscheiden** (E14: vorbereitet, aber nicht scharfgeschaltet).
5. **`W3027` erklären oder aufheben:** Die OS-Matrix läuft bei Pushes nur auf Ubuntu.
   Wer das nicht erklären mag, setzt Windows und macOS wieder in die Push-Matrix — und
   zahlt die 385 Minuten pro Push.

### Was aus Phase 11 zu wissen ist

- Die README richtet sich an jemanden, der den Adapter benutzt, nicht an den, der ihn
  baut. Vier Dinge stehen ausdrücklich drin, weil sie sonst niemand ahnt: wie der
  Schlüssel entsteht, dass `ack=true` nur die Übergabe meint, warum die Daten eine
  Stunde alt sein dürfen, und dass Überschussladen ohne `REDUCED` in der App nicht
  funktioniert.
- **`examples/pv-surplus-charging.js`** ist eine Vorlage, kein Produkt. Es schaltet nur
  bei steckendem Kabel, liest den Ist-Zustand aus `charging.status.state` statt aus dem
  eigenen Wunsch, und hat eine harte Obergrenze für Schaltvorgänge pro Stunde — jeder
  kostet zwei Requests.
- Beispielskripte laufen in der Sandbox des JavaScript-Adapters. ESLint kennt deren
  Globale nicht von selbst; `eslint.config.mjs` hat dafür einen eigenen Block.

### Was aus Phase 10 zu wissen ist

- **Der Integrationstest ist der einzige Ort, an dem der Adapter als Ganzes läuft.**
  Drei Suites: der normale Lebenslauf, der Neustart mitten im Quota-Fenster und der
  abgelaufene Schlüssel. Er braucht rund elf Minuten, weil die ioBroker-Umgebung dabei
  aufgebaut wird — lokal mit `npm run test:integration`.
- Der Mock läuft dabei **im Testprozess**; der Adapter bekommt seine Adresse über
  `SKODA_API_BASE_URL` beim Start. Der Mock ist damit zugleich Beobachtungspunkt: Was
  der Adapter tatsächlich abgesetzt hat, steht in `mock.requests`.
- **Was der Test nicht abdecken kann:** die Notification (dafür fehlt der Host-Prozess)
  und die Admin-UI selbst. Beides ist in einer echten Instanz von Hand nachgewiesen
  (Abschnitt 3).

### Was aus Phase 9 zu wissen ist

- **`onResponse(meta, error)`** ist der Rückkanal für alles, was in *jeder* Antwort
  steht. Bisher hängt nur der Schlüsselablauf daran; wer etwas Ähnliches braucht (der
  Header `RateLimit-*` geht schon an den QuotaManager), hängt es dort ein.
- **Der Block `notifications` steht in `io-package.json` auf oberster Ebene**, nicht
  unter `common` — der Notification-Handler liest `instanceObject.notifications`. Neue
  Kategorien müssen zusätzlich in `adapter-config.d.ts` unter `NotificationScopes`
  deklariert werden, sonst nimmt `registerNotification()` sie nicht an.
- Gemeldet wird **höchstens einmal am Tag je Stufe**, und ein erneuerter Schlüssel
  (mehr als 14 Tage Restlaufzeit) setzt die Eskalation zurück.
- Nachsehen, ob eine Notification wirklich ankam: der Zustand
  `system.host.<host>.notifications.skoda-public-api` enthält sie als JSON.

### Was aus den Phasen 6 bis 8 zu wissen ist

- **Der Scheduler schreibt keine States.** Er reicht die Antwort über `onVehicleData`
  nach oben, wo `main.ts` StateWriter und CommandQueue bedient.
- **`tick()` ist der ganze Motor** — bei Scheduler wie Queue: Es arbeitet ab, was fällig
  ist, und liefert die Zeit bis zum nächsten Mal. Tests stellen die Uhr um den
  Rückgabewert vor und brauchen keine echten Timer.
- **Der Soll-Schalter ist idempotent, der Knopf nicht.** Entspricht `enabled` dem
  zuletzt gepollten Ist, geht kein Request hinaus (`COALESCED`).
- **`404` setzt eine VIN dauerhaft aus, `401`/`403` drosseln auf einmal pro Stunde**
  und setzen `info.connection` auf false. Bei `429` bleibt die Verbindung bestehen.
- **Der S-PIN kommt aus der Instanzkonfiguration, niemals aus einem State** (E6/E14).

### Was aus den Phasen 3 bis 5 zu wissen ist

- **Jede Meldung der HTTP-Schicht ist maskiert** (E14). Wer selbst eine Meldung baut,
  die eine URL, eine VIN oder ein Geheimnis enthalten könnte, nimmt `createSanitizer()`.
- **`vehicleErrors(response)`** ist die einzige Stelle, die `errors ?? []` umsetzt
  (Fallstrick 10).
- **Die beiden `429` unterscheiden sich nur am `type`.**
- **Der QuotaManager glaubt den Headern, nicht seiner eigenen Rechnung.** Polls halten
  bei der Reserve an, Befehle dürfen sie aufbrauchen.
- **Der StateWriter legt nur an, was in der Antwort steht, und löscht nie.** Fehlende
  Teile behalten ihren Wert und bekommen Quality `0x01`.

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
