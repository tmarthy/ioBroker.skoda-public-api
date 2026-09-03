# Implementierungsplan — ioBroker.skoda-public-api

Stand: 2026-09-01. Grundlage: `docs/design-decisions.md` (E1–E16) und
`spec/skoda-openapi.json`.

Ziel: Ein ioBroker-Adapter für die offizielle MyŠkoda Public API, der einen
Škoda Enyaq ausliest und steuert, unter der harten Randbedingung von
**20 API-Requests pro Stunde**.

---

## 1. Zielarchitektur

Vier Schichten, strikt getrennt, jede einzeln testbar. Der Datenfluss geht nur
in eine Richtung; die Schichten kennen jeweils nur die darunterliegende.

```
         ioBroker (States, Admin-UI, Skripte des Nutzers)
                        |            ^
             Befehle    v            |   States
         +--------------------------------------------+
         |  main.ts   Lifecycle, Verdrahtung           |
         +--------------------------------------------+
         |  CommandQueue        |     StateWriter      |   Schicht 4
         |  (Soll, Coalescing)  |     (JSON -> States) |
         +--------------------------------------------+
         |  PollScheduler       |                      |   Schicht 3
         |  (Kadenz, Backoff)   |                      |
         +--------------------------------------------+
         |  QuotaManager  (ein Bucket pro Instanz)     |   Schicht 2
         +--------------------------------------------+
         |  SkodaApiClient  (fetch, Header, sanitize)  |   Schicht 1
         +--------------------------------------------+
                        |
              Škoda Public API  /  Mock-Server
```

**Regel:** Kein Request verlässt den Adapter, ohne den QuotaManager passiert zu
haben. Weder Scheduler noch CommandQueue rufen den Client direkt auf.

## 2. Dateibaum (Ziel)

```
ioBroker.skoda-public-api/
├── src/
│   ├── main.ts                          Adapter-Klasse, Lifecycle, Verdrahtung
│   └── lib/
│       ├── api/
│       │   ├── client.ts                SkodaApiClient
│       │   ├── errors.ts                ProblemDetail -> typisierte Fehler-Union
│       │   ├── sanitize.ts              VIN/Key-Maskierung (E14)
│       │   └── types.generated.ts       aus spec/ generiert, nicht editieren
│       ├── quota/
│       │   └── QuotaManager.ts          Bucket, Reserve, Persistenz (E9)
│       ├── scheduler/
│       │   └── PollScheduler.ts         Kadenz + Frische-Backoff (E12/E7)
│       ├── commands/
│       │   ├── CommandQueue.ts          Soll-Zustand, Coalescing, TTL (E5)
│       │   └── commandMap.ts            State-ID -> Endpunkt + Body-Builder
│       ├── states/
│       │   ├── objectDefs.generated.ts  Pfad -> common (aus Spec)
│       │   ├── objectOverlay.ts         Rollen/Einheiten/Labels, handgepflegt
│       │   └── StateWriter.ts           lazy anlegen, setStateChanged, Quality
│       └── notifications/
│           └── keyExpiry.ts             Schwellen 14/7/2 (E10)
├── admin/
│   └── jsonConfig.json
├── spec/
│   └── skoda-openapi.json               eingecheckt, Referenz für Codegen + Diff
├── tools/
│   ├── generate-types.ts                openapi-typescript + tings-Workaround
│   ├── generate-objectdefs.ts           Spec -> objectDefs.generated.ts
│   └── check-spec.ts                    Diff gegen Live-Spec (CI, wöchentlich)
├── test/
│   ├── fixtures/                        echte, anonymisierte Antworten
│   ├── mock/server.ts                   Entwicklungs- und Testserver (E12)
│   ├── unit/
│   └── integration/
├── examples/
│   └── pv-surplus-charging.js           Vorlage für die Regellogik (E4)
└── docs/
    ├── design-decisions.md
    └── implementation-plan.md
```

---

## 3. Phasen

Aufwand als grobe Größenordnung: **S** = ein Abend, **M** = ein Wochenende,
**L** = mehrere Wochenenden.

### Phase 0 — Projektgerüst · S

`npx @iobroker/create-adapter` im Projektordner mit diesen Antworten:

| Frage | Antwort |
|---|---|
| Adaptername | `skoda-public-api` |
| Titel | `Škoda Public API` (ohne "ioBroker"/"Adapter") |
| Sprache | TypeScript |
| Adapter-Typ | `vehicle` |
| Startmodus | `daemon` |
| Admin-UI | JSON Config |
| Tests | Ja (`@iobroker/testing`) |
| Node-Version | 22 (Minimum; Node 20 ist EOL) |
| Lizenz | MIT |

Sentry wird von `create-adapter` nicht mehr abgefragt; `@iobroker/plugin-sentry` kommt
bei Bedarf zur Veröffentlichung von Hand dazu (E14).

Danach: `npx @iobroker/dev-server setup`, erster Commit.
Die beiden `docs/`-Dateien und `spec/skoda-openapi.json` wandern mit ins Repo.

**Fertig, wenn:** `npm run test:package` grün, `dev-server watch` startet die
Instanz, Admin unter `http://localhost:8081` erreichbar.

### Phase 1 — Spec, Codegen, Spec-Wächter · M · **erledigt**

> **Abweichungen von der ursprünglichen Planung:**
> - Die Werkzeuge sind `.mjs` statt `.ts`. `openapi-typescript` v7 ist ESM-only, und
>   ein TS-Runner für Skripte, die nie ausgeliefert werden, wäre eine Abhängigkeit
>   ohne Gegenwert.
> - Overlay und Generat werden **zur Laufzeit** in `resolveCommon()` zusammengeführt,
>   nicht beim Generieren. So kann der Codegen jederzeit neu laufen, ohne
>   handgepflegte Werte zu überschreiben — und die Zusammenführung ist testbar.
> - Der Prosa-Parser für Aufzählungswerte deckt vier Formate ab statt einem
>   (Aufzählungspunkte, Klammerliste, Backticks, Kommaliste). Damit entstehen
>   27 von 27 Aufzählungen automatisch; keine muss von Hand gepflegt werden.
> - `tsconfig.json` brauchte `"types": ["node", "mocha"]`. `@tsconfig/node22` setzt
>   `"types": ["node"]` und blendet damit die Mocha-Typen aus — `npm run check` war
>   schon aus dem Generator heraus rot.
> - Generierte Dateien sind von ESLint und Prettier ausgenommen.


1. `tools/generate-types.ts`: lädt `spec/skoda-openapi.json`, **entfernt vorher die
   Eigenschaft `tings` aus `Charging` und `ChargingProfile`** (Fehler in Škodas
   Spec, siehe Restrisiko 5 — ohne das entsteht eine unendliche Typrekursion),
   ruft `openapi-typescript` auf, schreibt `src/lib/api/types.generated.ts`.
2. `tools/generate-objectdefs.ts`: läuft denselben Schemabaum ab und erzeugt eine
   Map `Pfad -> ioBroker.StateCommon` mit `type` und, wo die Spec ein Enum kennt,
   `states`. Rollen, Einheiten und deutsche Enum-Labels kommen aus
   `objectOverlay.ts` (handgepflegt) und überschreiben das Generat.
3. `tools/check-spec.ts` plus GitHub-Action (wöchentlich, `workflow_dispatch`):
   holt `/v3/api-docs`, vergleicht mit der eingecheckten Kopie, öffnet bei
   Abweichung ein Issue mit dem Diff.

**Overlay-Startwerte** (`objectOverlay.ts`):

| Pfad-Endung | role | unit |
|---|---|---|
| `stateOfChargeInPercent`, `currentSoCInPercent` | `value.battery` | `%` |
| `chargePowerInKw` | `value.power` | `kW` |
| `mileageInKm`, `remainingRangeInKm`, `totalRangeInKm` | `value.distance` | `km` |
| `remainingCruisingRangeInMeters` | `value.distance` | `m` |
| `*InMinutes`, `durationInSeconds` | `value` | `min` / `s` |
| `targetTemperature.value` | `value.temperature` | `°C` |
| `carCapturedTimestamp`, `fullyChargedAt`, `estimatedReach*` | `date` | — |
| `latitude` / `longitude` | `value.gps.latitude` / `.longitude` | `°` |
| `doorsLocked`, `locked` | `sensor.lock` | — |
| `doors`, `windows`, `sunroof`, `trunk`, `bonnet` | `sensor.door`/`.window` | — |
| `lights` | `sensor.light` | — |

**Fertig, wenn:** `npm run codegen` erzeugt beide Dateien, `npm run build`
kompiliert fehlerfrei, der Spec-Wächter läuft manuell durch.

### Phase 2 — Fixtures und Mock-Server · M · **erledigt**

> **Stand:** vollstaendig. Mock-Server, Aufnahmewerkzeug und alle vier echten
> Aufnahmen liegen vor; 66 Tests decken Quota-Buchhaltung, alle Fehlerfamilien,
> `include`-Filterung, Befehlswirkung und den Abgleich der Aufnahmen gegen das
> Generat ab. Was die echten Daten ueber die API verraten, steht in HANDOFF.md,
> Abschnitt 4.
>
> **Aufnahme am Fahrzeug** (jede Aufnahme kostet einen Request aus dem Stundenbudget):
>
> ```
> export SKODA_API_KEY='...'      # aus der MyŠkoda-App
> export SKODA_VIN='...'
> node tools/capture-fixtures.mjs idle              "Geparkt, Kabel ab"
> node tools/capture-fixtures.mjs plugged           "Kabel dran, laedt nicht"
> node tools/capture-fixtures.mjs charging          "Laedt gerade"
> node tools/capture-fixtures.mjs climatising       "Klimatisierung laeuft"
> ```
>
> Das Werkzeug anonymisiert VIN, Kennzeichen, Fahrzeugname, Adresse und Koordinaten
> und bricht ab, falls danach noch eine Spur der echten VIN oder des Schluessels in
> der Datei steht. Schluessel und VIN werden nie protokolliert.
>
> Danach `test/fixtures/vehicle-synth-idle.json` durch `vehicle-idle.json` ersetzen
> (im Mock via `fixture: 'idle'`) und das synthetische Fixture behalten, solange es
> Faelle abdeckt, die am eigenen Fahrzeug nicht auftreten.

**Abweichung von der Planung:** Der Mock kennt 13 Szenarien statt der geplanten elf —
`bad-request` entsteht bereits aus einem unbekannten `include`-Wert und braucht keinen
Schalter, dafuer sind `not-found`, `gateway-timeout` und `partial-data` eigenstaendig
schaltbar. Die Zuordnung Antwortteil ↔ Fehlertyp (`CHARGING_UNAVAILABLE` usw.) liegt in
`src/lib/api/parts.ts`, nicht im Mock: Der StateWriter braucht sie in Phase 5 ebenfalls,
und ein Test haelt sie gegen die Spec-Beschreibung.


Vorgezogen, weil alle folgenden Phasen ihn brauchen (E12).

1. **Aufnahme am echten Auto** — kostet ~5 Requests, muss *dein* Enyaq sein:
   ein Poll im Ruhezustand, einer am Kabel ohne Laden, einer während des Ladens,
   einer mit laufender Klimatisierung, einer nach einem Befehl.
   VIN durch `TMBJB9NY5RF999999` ersetzen, `formattedAddress` und Koordinaten
   durch Beispielwerte.
2. **Von Hand ergänzte Fixtures:** Antwort mit nicht-leerem `errors[]`, Antwort
   ohne `charging`-Block, Antwort eines Verbrenners (aus der Spec konstruiert).
3. **`test/mock/server.ts`:** `node:http`, Routen wie die echte API, dazu
   - vollständige `RateLimit-Limit` / `-Remaining` / `-Reset`-Buchhaltung
   - `X-API-Key-Expires-At`
   - ein Szenario-Schalter (Query oder Env), der auf Kommando `401 api-key-expired`,
     `403 api-key-not-authorized`, `422 operation-not-supported`,
     `422 operation-disabled`, `429 rate-limit-exceeded`,
     `429 vehicle-not-accepting-requests`, `500`, `503` liefert
   - `202` auf alle POSTs, mit optionaler verzögerter Zustandsänderung im
     nachfolgenden GET (damit der Verifikations-Poll etwas zu sehen bekommt)

Adapter-Basis-URL über `SKODA_API_BASE_URL` umschaltbar, sonst der Live-Wert (E12).

**Fertig, wenn:** Alle elf Fehlerfälle aus der Tabelle in Abschnitt 5 lassen sich
per Schalter reproduzieren, und die `RateLimit-*`-Header verhalten sich über
mehrere Requests plausibel.

### Phase 3 — HTTP-Schicht · M · **erledigt**

> **Abweichungen von der ursprünglichen Planung:**
> - Die Union hat eine zwölfte Fehlerart `unexpected` als Auffangfall. Ohne sie landet
>   eine Antwort, die in keine Zeile der Tabelle passt — ein `401` mit `about:blank`,
>   ein `418`, ein `200` ohne `vehicle` — nirgends. Sie wird nie wiederholt, und ihr
>   Quota-Verbrauch folgt der allgemeinen Regel (alles außer 401, 403, 429).
> - Jeder Fehler trägt neben `retryable` auch **`maxRetries`**, direkt aus der dritten
>   Spalte der Fehlertabelle. Sonst müssten die Phasen 6 und 7 dieselbe Tabelle noch
>   einmal führen. `rate-limit-exceeded` bekommt `Infinity`: Dort begrenzt die TTL des
>   Befehls, kein Zähler.
> - `retryAfterMs` kommt **ausschließlich** aus `Retry-After`. Kein Rückfall auf
>   `RateLimit-Reset` — der steht ohnehin in `meta.rateLimit` und die Entscheidung, wie
>   lange gewartet wird, gehört nicht in den Client.
> - `vehicleErrors(response)` ist die einzige Stelle, die `errors ?? []` umsetzt
>   (Fallstrick 10). Der Client normalisiert die Antwort **nicht** — der optionale Typ
>   ist der Wächter, der `.errors.map(...)` verhindert.
> - Der Netzwerkfehler wird mit `consumesQuota: true` gemeldet. Die Tabelle sagt
>   „unbekannt"; `true` ist die konservative Lesart, die sie vorschreibt.
> - Die Basis-URL wird beim Konstruktor geprüft. Eine unbrauchbare
>   `SKODA_API_BASE_URL` soll beim Start auffallen, nicht beim ersten Request.

- **`sanitize.ts`** — ersetzt VIN (`[A-HJ-NPR-Z0-9]{17}`) und den API-Key in jedem
  String durch `<VIN>` bzw. `<KEY>`. Wird von `client.ts` auf **jede** erzeugte
  Meldung angewandt. Nie eine Fehlermeldung aus einer rohen URL bauen.
- **`errors.ts`** — parst `application/problem+json` nach einer diskriminierten
  Union: `ApiKeyExpired`, `ApiKeyNotAuthorized`, `OperationNotAuthorized`,
  `OperationNotSupported`, `OperationDisabled`, `RateLimitExceeded`,
  `VehicleNotAcceptingRequests`, `BadRequest`, `NotFound`, `ServerError`,
  `NetworkError`. Jeder Fall trägt `retryable`, `consumesQuota` und `retryAfterMs`.
- **`client.ts`** — `getVehicle(vin, include?)` und
  `sendCommand(vin, domain, action, body?)`. Liest `RateLimit-*` und
  `X-API-Key-Expires-At` aus jeder Antwort und gibt sie mit zurück.
  Timeout via `AbortSignal.timeout()`.

**Fertig, wenn:** Unit-Tests decken jede Zeile der Fehlertabelle ab, und ein Test
prüft explizit, dass in keiner erzeugten Meldung VIN oder Key auftauchen.
Beides liegt vor: `errors.test.ts` prüft die Tabelle Zeile für Zeile,
`client.test.ts` dieselben Zeilen noch einmal gegen echte HTTP-Antworten des Mocks.

### Phase 4 — QuotaManager · M · **erledigt**

> **Abweichungen von der ursprünglichen Planung:**
> - `recordResponse(meta)` statt `recordResponse(headers, consumedQuota)`. Der Client
>   wertet die `RateLimit-*`-Header bereits aus; ein zweiter Parser wäre eine zweite
>   Stelle, die bei einer Änderung nachgezogen werden muss. Der Manager kennt damit
>   Schicht 1, wie es der Datenfluss vorsieht.
> - `tryAcquire()` liefert bei einer Ablehnung neben `waitMs` auch einen `reason`
>   (`reserve`, `exhausted`, `startup-guard`). Sonst müsste Phase 6 für die Logzeile
>   „warum kein Poll?" dieselbe Bedingung noch einmal auswerten.
> - **Das „minimale Intervall" ist eine Sperrfrist nach dem Start, kein dauerhafter
>   Mindestabstand.** Als dauerhafter Abstand (Fenster ÷ Limit = 3 min) würde er den
>   Verifikations-Poll 60 s nach einem Befehl blockieren, den die Tabelle in Phase 6
>   ausdrücklich vorsieht. Er gilt deshalb nur für den ersten Request eines frischen
>   Prozesses — genau dort, wo die Neustartschleife entsteht — und für Polls wie
>   Befehle gleichermaßen.
> - **Gespeichert wird beim Absetzen des Requests, nicht erst bei der Antwort**, und
>   zwar der um die laufenden Requests verminderte Stand. Ein Absturz zwischen Request
>   und Antwort ist der Fall, gegen den die Persistenz gebaut ist; würde erst die
>   Antwort speichern, bliebe er unsichtbar.
> - Laufende Requests werden mitgezählt (`inFlight`), damit zwei gleichzeitig
>   abgesetzte Requests nicht beide denselben Reststand sehen.
> - Die Persistenz hängt an einer Schnittstelle `QuotaStore`, nicht an einer
>   Adapter-Instanz: Der Manager kennt kein ioBroker, und die Tests brauchen keins.
>   **Offen bleibt die Anbindung an `info.rateLimit.*` — sie kommt in Phase 6 mit der
>   Verdrahtung in `main.ts`.**

Zustand: `limit`, `remaining`, `resetAt`, `lastRequestAt`.
Quelle der Wahrheit sind **immer die Response-Header**, nie die eigene Zählung —
die dient nur als Schätzung bis zur ersten Antwort.

Schnittstelle:
```
tryAcquire(priority: 'poll' | 'command'): 'ok' | { waitMs: number }
recordResponse(headers, consumedQuota: boolean): void
snapshot(): { limit, remaining, resetAt, reserveFree }
```

- `poll` wird abgelehnt, sobald `remaining <= commandReserve` (Default 6).
- `command` darf bis `remaining === 0` gehen.
- **Persistenz gegen Crash-Loops:** `remaining`, `resetAt` und `lastRequestAt`
  werden in `info.rateLimit.*` geschrieben und beim Start gelesen. Liegt der
  letzte Request weniger als das minimale Intervall zurück, wartet der Adapter.
  Ohne das verbrennt eine Instanz in Neustartschleife 20 Requests in 90 Sekunden.

**Fertig, wenn:** Unit-Tests für: Reserve wird nie von Polls unterschritten;
`429` reduziert `remaining` nicht; `401`/`403` reduzieren `remaining` nicht;
`503` reduziert `remaining`; Zustand übersteht einen simulierten Neustart.
Alle fünf liegen vor, dazu die Neustartschleife selbst als Test (30 Starts in 90
Sekunden setzen genau einen Request ab) und das Zusammenspiel mit Client und Mock:
Der Poll hält von selbst an, bevor die API mit `429` antworten muss.

### Phase 5 — StateWriter · M · **erledigt**

> **Abweichungen von der ursprünglichen Planung:**
> - Der Writer schreibt gegen eine schmale Schnittstelle `StateApi` (vier Methoden plus
>   Logger) statt gegen eine Adapter-Instanz. Ein Test beweist zur Übersetzungszeit,
>   dass eine echte `ioBroker.Adapter` sie erfüllt — sonst fiele das erst bei der
>   Verdrahtung in Phase 6 auf.
> - Zusätzlich zu den in E16 genannten Profil-States entsteht ein `settingsJson`.
>   Sonst wäre `settings.maxChargingCurrent` nirgends sichtbar — ausgerechnet der Wert,
>   an dem die Wirksamkeit des Überschussladens hängt (E3). Ein Objektbaum entsteht
>   dadurch nicht; das entspricht der Überschrift von E16, „JSON darunter".
> - **Das Quality-Flag wird nur für Teile gesetzt, die die API in `errors[]` gemeldet
>   hat.** Ein Teil, das per `include` gar nicht angefordert wurde, fehlt nicht — es
>   wurde nur nicht aufgefrischt. Sonst würde jeder Poll mit gelernter `include`-Liste
>   abgeschaltete Teile (z. B. die Parkposition, E14) dauerhaft als gestört markieren.
> - Beim Zurückkommen eines Teils wird die Qualität mit einem unbedingten `setState`
>   wieder auf „gut" gesetzt. `setStateChanged` allein schreibt bei unverändertem Wert
>   nicht — das Flag bliebe stehen, obwohl der Wert wieder frisch ist.
> - `info.dataAge` bezieht sich auf den **jüngsten** `carCapturedTimestamp` der
>   Antwort: Er beantwortet „wann hat das Auto zuletzt etwas gemeldet".
> - Zustände, die der Adapter selbst bildet (`info.*`, `parkingPosition.position`, die
>   Profilebene), laufen über einen eigenen Weg und lösen deshalb **keine** Warnung
>   über eine geänderte Spec aus.
> - Die Zuordnung Domäne ↔ Antwortblock steht in `src/lib/states/commandDefs.ts`, weil
>   Phase 7 sie ebenfalls braucht (Endpunktpfad und Soll/Ist-Vergleich).

- Läuft den JSON-Baum ab, legt Objekte **nur für vorhandene Pfade** an (E13),
  einmal pro Pfad gemerkt, danach nur noch `setStateChanged` (E16).
- `common` kommt aus `objectDefs.generated.ts`, überschrieben von `objectOverlay.ts`.
  Unbekannte Pfade: Typ aus `typeof`, `role: 'state'`, Warnung ins Log (Hinweis
  auf eine Spec-Änderung).
- Fehlende Teile: Werte stehenlassen, Quality-Flag auf "nicht gut" (E8).
- Sonderfälle:
  - `parkingPosition.position` = `` `${lat};${lon}` ``, `role: value.gps`
  - `<vin>.info.dataAge` = Sekunden seit `carCapturedTimestamp`
  - `chargingProfiles.profiles.<id>.*` ID-basiert; `timersJson` und
    `preferredChargingTimesJson` als JSON-String (E16)
  - `errors[]` -> `info.lastErrors` als JSON
  - Device-Objekt `<vin>` bekommt `common.name` aus `vehicle.name` bzw.
    `licensePlate`
- Legt die Befehls-States **aus derselben Fähigkeitserkennung** an: kein
  `auxiliaryHeating`-Block in der Antwort -> keine zugehörigen Buttons (E15).

**Fertig, wenn:** Für jedes Fixture aus Phase 2 erzeugt der Writer den erwarteten
Objektbaum (Snapshot-Test), und ein zweiter Durchlauf mit identischen Daten
schreibt keinen einzigen State.
Beides liegt vor: Der Baum der echten Aufnahme steht als ausgeschriebene Liste von
76 Objekten im Test, alle fünf Aufnahmen werden zusätzlich Feld für Feld gegen die
erzeugten Zustände gehalten, und der zweite Durchlauf schreibt nachweislich nichts.

### Phase 6 — PollScheduler · M · **Meilenstein 1: lesender Adapter**

| Zustand | Intervall |
|---|---|
| Basis | 15 min (konfigurierbar, Untergrenze 5) |
| Aktiv (`CHARGING` oder Klima ≠ `OFF`) | 5 min (Untergrenze 3) |
| Nach Befehl | ein Verifikations-Poll nach 60 s, danach 10 min aktive Kadenz |
| Frische-Backoff | Verdoppelung bei unverändertem `carCapturedTimestamp`, Deckel 60 min |

Der Frische-Backoff ist der größte Einzelhebel: Ein schlafendes Auto liefert bei
jedem Poll denselben Zeitstempel — schneller zu pollen bringt null Information
und kostet volles Budget. Ändert sich der Zeitstempel, sofort zurück auf Basis.

Erster Poll ohne `include` (Fähigkeitserkennung), danach mit der gelernten Liste
— abzüglich `parkingPosition`, falls abgeschaltet (E14).

Bei mehreren VINs: reihum aus demselben Bucket.

**Fertig, wenn:** Der Adapter läuft gegen den Mock über eine simulierte Stunde,
bleibt unter 20 Requests, füllt den Objektbaum und drosselt sich beim schlafenden
Auto messbar herunter.

### Phase 7 — CommandQueue · M · **Meilenstein 2: steuernder Adapter**

- Nimmt Schreibvorgänge auf `<vin>.<domain>.enabled` (Soll) und
  `<vin>.<domain>.start|stop` (erzwungen) entgegen.
- **Idempotenz:** Soll gleich Ist -> kein Request, Ergebnis `COALESCED`.
- **Coalescing:** Ein neuer Soll-Wert ersetzt den wartenden Eintrag derselben
  Domäne. Entspricht der neue Soll dem Ist, verfällt der Eintrag ersatzlos.
- **TTL 10 min.** Ist `Retry-After` länger als die Rest-TTL: sofort `EXPIRED` (E15).
- `air-conditioning/start` baut den Body aus den gepufferten States
  `targetTemperature` und `airConditioningWithoutExternalPower`.
  `auxiliary-heating/start` nimmt den S-PIN aus der Instanzkonfiguration —
  **niemals aus einem State** (E6/E14).
- Ergebnis nach `info.lastCommand.{name,timestamp,result,problemType}`,
  `ack=true` bei erfolgreicher Übergabe an die API.
- Danach Verifikations-Poll anstoßen.

**Fertig, wenn:** Integrationstest: `enabled=true`, dann innerhalb der TTL
`enabled=false` -> null Requests, Ergebnis `COALESCED`. Und: `enabled=true` bei
leerem Budget -> `QUEUED`, Ausführung nach Reset.

### Phase 8 — Admin-UI · S

`admin/jsonConfig.json`:

| Feld | Typ | Default | Anmerkung |
|---|---|---|---|
| `apiKey` | text, `encryptedNative` + `protectedNative` | — | Pflicht |
| `vins` | Tabelle (`vin`, optional `label`) | — | Pflicht, 17 Zeichen validiert |
| `spin` | text, verschlüsselt | leer | nur für Standheizung |
| `pollIntervalIdle` | number [min] | 15 | min. 5 |
| `pollIntervalActive` | number [min] | 5 | min. 3 |
| `pollBackoffMax` | number [min] | 60 | |
| `commandReserve` | number | 6 | 0–15 |
| `commandTtl` | number [min] | 10 | |
| `readParkingPosition` | checkbox | an | E14 |

Dazu ein **"Verbindung testen"-Button** (`sendTo`), der genau einen `GET` absetzt
und Key, VIN, Ablaufdatum und Restquota zurückmeldet. Ohne ihn äußert sich ein
Tippfehler in der VIN als `403 api-key-not-authorized` — eine Meldung, aus der
niemand die Ursache errät. Der Test kostet einen Request; das gehört in den
Hinweistext.

**Keine** Basis-URL in der UI (E12).

### Phase 9 — Key-Ablauf und Notifications · S

- `X-API-Key-Expires-At` aus jeder Antwort nach `info.apiKey.expiresAt`,
  daraus `info.apiKey.daysRemaining`.
- Log-Eskalation 14 (`info`) / 7 (`warn`) / 2 (`error`) Tage, jeweils höchstens
  einmal pro Tag.
- `notifications`-Scope in `io-package.json`, `registerNotification()` ab 7 Tagen.
- Bei `401 api-key-expired`: `info.connection = false`, Polling auf 1×/h,
  Notification.
- `info.connection` bleibt bei `429` **true** (E10).

### Phase 10 — Tests und CI vervollständigen · M

- Unit: `QuotaManager`, `CommandQueue`, `StateWriter`, `errors`, `sanitize`.
- Integration: Adapter gegen den Mock über eine simulierte Stunde, inklusive
  Neustart mitten im Fenster.
- `@iobroker/testing`: Paket- und Startup-Tests.
- GitHub Actions: Lint, Build, Test auf Node 22 und 24; Spec-Wächter wöchentlich.

### Phase 11 — Beispielskript und Dokumentation · S

`examples/pv-surplus-charging.js` — kommentierte Bang-Bang-Regelung:
Einschaltschwelle, Ausschaltschwelle mit Verzögerung, Mindest-Ein- und
Ausschaltdauer, Obergrenze für Schaltvorgänge pro Stunde, Auswertung von
`info.lastCommand.result`.

README mit: Erstellung des API-Keys in der MyŠkoda-App, dem Rate-Limit und seinen
Folgen (ausdrücklich: **kein sekundengenaues Monitoring, keine sofortige
Benachrichtigung bei Ladeende**), Hinweis auf `REDUCED` für Überschussladen,
Beschreibung von `info.*`, und der Aussage, dass `ack=true` nur die Übergabe an
die API bedeutet.

### Phase 12 — Release-Vorbereitung · S

`@alcalzone/release-script`, Übersetzungen mit `@iobroker/adapter-dev translate`
(DE/EN von Hand, Rest maschinell), Adapter-Checker durchlaufen lassen,
Entscheidung über die Einreichung ins offizielle Repo (E1).

---

## 4. Abhängigkeiten zwischen den Phasen

```
0 ──> 1 ──> 2 ──> 3 ──> 4 ──> 6 ──────> M1 (lesend)
                   │      └──> 5 ──┘
                   │
                   └──> 7 ──> M2 (steuernd)   [braucht 4, 5, 6]
                        │
        8, 9 ───────────┘
        10 laufend ab Phase 3
        11, 12 zum Schluss
```

Phase 2 blockiert alles Weitere — ohne Mock ist Entwicklung praktisch unmöglich.
Die Aufnahme der Fixtures braucht das echte Auto und sollte deshalb früh
eingeplant werden.

---

## 5. Fehlerbehandlung (verbindliche Tabelle)

| Antwort | Quota | Retry | Reaktion |
|---|---|---|---|
| `202 Accepted` | ja | — | Verifikations-Poll nach 60 s |
| `400 Bad Request` | ja | nein | Fehler im Adapter, loggen, Befehl verwerfen |
| `401 api-key-expired` | **nein** | nein | `connection=false`, Notification, Polling 1×/h |
| `403 api-key-not-authorized` | **nein** | nein | `connection=false`, Konfigurationshinweis |
| `403 operation-not-authorized` | ja | nein | Befehl verwerfen, loggen |
| `404 Not Found` | ja | nein | VIN prüfen, Polling für diese VIN aussetzen |
| `422 operation-not-supported` | ja | nein | Fähigkeit dauerhaft merken, State deaktivieren |
| `422 operation-disabled` | ja | nein | verwerfen, nicht dauerhaft merken |
| `429 rate-limit-exceeded` | **nein** | ja | `Retry-After` abwarten, Befehl bleibt in Queue |
| `429 vehicle-not-accepting-requests` | **nein** | ja, begrenzt | `Retry-After` + Backoff, max. 3 Versuche |
| `500` / `503` / `504` | ja | **max. 1** | Jitter, nur oberhalb der Befehlsreserve |
| Netzwerkfehler / Timeout | unbekannt | max. 1 | konservativ als verbraucht zählen |

Die dritte Spalte ist der Grund für die Zurückhaltung bei `5xx`: Drei Retries auf
einen wackeligen Server sind vier Requests — ein Fünftel der Stunde, verbrannt an
einer Störung, die man nicht beeinflussen kann.

**Diese Tabelle hat Vorrang vor der pauschalen Regel** „Quota-Verbrauch: alle Antworten
außer 401, 403, 429" aus `design-decisions.md`. Die beiden widersprechen sich an genau
einer Stelle: `403 operation-not-authorized` steht hier als quotaverbrauchend. Die
feinere Angabe ist umgesetzt (Phase 3) und der Mock verhält sich so — nachgemessen ist
sie nicht, denn dafür müsste man am echten Fahrzeug einen Befehl auslösen, den der
Nutzer nicht ausführen darf. Praktische Folge ist gering: Ab Phase 4 sind die
`RateLimit-*`-Header die Quelle der Wahrheit, die Angabe im Fehler ist nur die
Schätzung bis zur nächsten Antwort.

---

## 6. Sofort nächste Schritte

1. Phase 0 ausführen (`create-adapter`, `dev-server setup`, erster Commit).
2. API-Key in der MyŠkoda-App erzeugen, für den Enyaq freigeben,
   Ablaufdatum notieren.
3. Fixtures aufnehmen (Phase 2, Schritt 1) — braucht das Auto in verschiedenen
   Zuständen, also über ein, zwei Tage verteilt.
4. Parallel dazu Phase 1 (Codegen) — hängt nicht am Auto.
