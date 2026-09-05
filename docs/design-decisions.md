# Entwurfsentscheidungen — ioBroker.skoda-public-api

Ergebnis der Entwurfsdiskussion vom 2026-09-01. Jede Zeile hier ist eine bewusst
getroffene Entscheidung, keine Vermutung. Wer den Adapter später ändert, sollte
den Abschnitt "Begründung" lesen, bevor er eine davon umdreht.

## Randbedingungen der API (nicht verhandelbar)

Quelle: <https://public.api.connect.skoda-auto.cz/docs>, Spec unter `spec/skoda-openapi.json`
(`info.version: v0`, heruntergeladen 2026-09-01).

| Eigenschaft | Wert |
|---|---|
| Authentifizierung | statischer `X-API-Key`, erzeugt in der MyŠkoda-App (ab v8.16) |
| Key-Gültigkeit | begrenzt, Ablauf nur via Header `X-API-Key-Expires-At` sichtbar |
| Key-Bindung | an die bei der Erstellung ausgewählten VINs |
| Basis-URL | `https://public.api.connect.skoda-auto.cz/api/v1` |
| Lese-Endpunkte | genau einer: `GET /vehicles/{vin}` (optional `?include=`) |
| Schreib-Endpunkte | 8 POSTs: `charging`, `air-conditioning`, `auxiliary-heating`, `active-ventilation` — je `start`/`stop` |
| Rate-Limit | **20 Requests/Stunde pro API-Key** (laut Doku "not final") |
| Quota-Verbrauch | alle Antworten **außer** 401, 403, 429 |
| Rückmeldung auf Befehle | `202 Accepted`, **kein Operation-Status-Endpunkt** |
| Fahrzeugliste | **existiert nicht** — VIN muss manuell konfiguriert werden |
| Push/Webhooks | keine |

Nicht in der API enthalten und daher unmöglich: Ver-/Entriegeln, Hupe/Lichthupe,
Setzen des Ladestroms, Setzen des Ziel-SoC, Ändern von Ladeprofilen oder Timern,
automatische Key-Rotation.

## Entscheidungen

### E1 — Qualitätsniveau: repo-tauglich bauen, Veröffentlichung offen
Aufsetzen mit `@iobroker/create-adapter`, saubere `io-package.json`, JSON Config,
Tests, CI. Die Entscheidung über die Einreichung ins offizielle Repo fällt später.
**Begründung:** Die Kosten des Gerüsts fallen einmalig am Anfang an; Nachrüsten ist
deutlich teurer.

> **Entschieden am 2026-09-04 (nach Phase 12): Der Adapter bleibt privat.**
> Keine Einreichung, keine npm-Veröffentlichung, kein Sentry. Was daraus folgt:
> - Die gemischte Sprache bleibt: Logmeldungen, Notification-Texte und der
>   Verbindungstest sind deutsch, README und Admin-Labels englisch. Für den
>   Eigenbetrieb ist das stimmig.
> - Der `deploy`-Job im Workflow bleibt auskommentiert.
> - `W3027` des Adapter-Checkers (reduzierte OS-Matrix) bleibt bewusst stehen —
>   Windows und macOS laufen nur beim Release-Tag, weil ein Push mit voller Matrix
>   385 abgerechnete Actions-Minuten kostet.
>
> Das Gerüst aus E1 war trotzdem richtig: Ohne Tests und CI wäre keine der zwölf
> Phasen belastbar gewesen. Die Entscheidung ist umkehrbar — was für eine spätere
> Einreichung zu tun wäre, steht in HANDOFF.md, Abschnitt 7.

### E2 — Name: `ioBroker.skoda-public-api`
npm-Paket `iobroker.skoda-public-api`. Bindestrich statt Unterstrich (Konvention:
271 von 797 Repo-Adaptern nutzen Bindestriche, 8 nutzen Unterstriche).
Terminologie folgt Škoda ("MyŠkoda Public API").
**Begründung:** Herkunft soll im Namen erkennbar sein, um Verwechslung mit
`vw-connect` (inoffizielle App-API) auszuschließen.

### E3 — Anwendungsfälle
Monitoring/VIS, Vorklimatisierung, zeit-/preisgesteuertes Laden, sowie
**eingeschränktes PV-Überschussladen** per Bang-Bang.
**Bekannte Einschränkung:** Ohne Strommodulation (API kann sie nicht) ist
Überschussladen nur sinnvoll, wenn der AC-Ladestrom in der MyŠkoda-App auf
`REDUCED` (z. B. 10 A ≈ 2,3 kW einphasig) steht. Die Wallbox (Bosch) hängt an
einem fremden Lademanagement und scheidet als Regelorgan aus.

### E4 — Regellogik lebt außerhalb des Adapters
Der Adapter ist ein reines API-Binding. Hysterese, Schwellen und Mindestlaufzeiten
gehören in ein ioBroker-Skript. Vorlage kommt nach `examples/pv-surplus-charging.js`.
**Begründung:** Jede PV-Anlage hat andere State-IDs und Zählersemantik; das in eine
Instanzkonfiguration zu pressen erzeugt Konfigurationshölle und macht den Adapter
untestbar. Die **Quota-Verwaltung bleibt aber im Adapter** — sonst müsste jedes
Skript die Rate-Limit-Logik neu bauen.

### E5 — Befehle: Queue mit Coalescing, TTL 10 Minuten
Befehl kommt in eine Queue, wird ausgeführt sobald Budget da ist, verfällt nach
10 min. Ergebnis in `info.lastCommand.result`: `SENT`, `QUEUED`, `COALESCED`,
`EXPIRED`, `REJECTED_BY_VEHICLE`.
**Begründung:** Bang-Bang-Regelung produziert Schaltnervosität (Wolke zieht durch).
Coalescing dämpft sie an der einzigen Stelle, die das Budget kennt.

**Präzisiert am 2026-09-05:** Auch ein mit `202` angenommener Sollwert darf gleiche
Schreibvorgänge nur begrenzt unterdrücken. Die Bestätigungsfrist ab Annahme entspricht
der konfigurierten TTL. Ein passender Ist-Zustand mit neuerem Fahrzeugzeitstempel hebt
sie vorzeitig auf. Nach Ablauf werden neue Schreibvorgänge wieder gegen frische Daten
geprüft; ohne neuere Daten gilt der Ist als unbekannt. Kein automatisches Nachsenden.

### E6 — Befehls-Interface: Schalter primär, Buttons sekundär
`<vin>.charging.enabled` (`role: switch`) trägt den **Soll-Zustand**;
`<vin>.charging.start` / `.stop` (`role: button`) erzwingen einen Aufruf.
Boolean-Abbildung: `true` genau bei `charging.status.state === 'CHARGING'`.
`CONNECT_CABLE`, `READY_FOR_CHARGING`, `CONSERVING` sind `false`.
**Begründung:** Coalescing auf einem Soll-Zustand ist ein trivialer Vergleich;
auf Buttons wäre es eine Heuristik.
`ack=true` bedeutet **"an die API übergeben"**, nicht "das Auto hat es getan" —
mehr weiß der Adapter wegen `202` ohne Status-Endpunkt nicht.

### E7 — Objektbaum: 1:1-Spiegel der API
Wurzel ist die VIN. Struktur folgt exakt dem JSON der Antwort.
**Begründung:** Bei `version: v0` erscheinen neue Felder von selbst; umbenannte
Felder fallen beim Regenerieren als Compile-Fehler auf statt als State, der still
aufhört sich zu aktualisieren.
**Typisierung** kommt aus der Spec (`type`, `unit`, `role`, `common.states` mit
deutschen Enum-Labels), unbekannte Felder werden dynamisch mit geratenem Typ angelegt.
**Ausnahmen vom 1:1-Prinzip:** zusätzlicher State `parkingPosition.position`
im Format `lat;lon` mit `role: value.gps` für VIS-Karten und Geofence-Adapter.

**Anzeigeeinheiten, Nutzerwunsch vom 2026-09-05:**
`charging.status.battery.remainingCruisingRangeInMeters` wird durch 1000 geteilt und
in km dargestellt. `activeVentilation.durationInSeconds` und
`auxiliaryHeating.durationInSeconds` werden durch 60 geteilt und in Minuten dargestellt.
Die bestehenden IDs bleiben erhalten, auch wenn ihre Endung die API-Einheit nennt.
Der StateWriter rechnet ausschließlich empfangene API-Werte um, ohne Rundung, und
aktualisiert vorhandene Objekteinheiten und Standardbeschreibungen beim nächsten
Empfang des Felds. Eigene Namen bleiben erhalten. Historien werden nicht umgerechnet;
Skripte müssen die neuen Einheiten berücksichtigen. Spec, Fixtures und Befehlsdaten
bleiben unverändert in den API-Einheiten.

### E8 — Umgang mit unvollständigen Antworten
Fehlende Teile **nicht** auf `null` setzen. Letzter Wert bleibt stehen,
Quality-Flag wird auf "nicht gut" gesetzt, `errors[]` landet als JSON in
`info.lastErrors`. Zusätzlich `<vin>.info.dataAge` in Sekunden aus
`carCapturedTimestamp`.
**Begründung:** `200` ist laut Doku regelmäßig unvollständig. Ohne diese Regel
flackert die VIS; ohne `dataAge` hält man tagealte Werte für aktuelle.

**Präzisiert am 2026-09-05:** Der Writer übernimmt vorhandene States und Qualitätsflags
beim ersten Poll nach dem Start. Neben Teilfehlern in `errors[]` markiert er auch
verschwundene Felder innerhalb gelieferter Teile und entfernte Profile. Absichtlich
nicht angeforderte Teile bleiben unverändert. `dataAge` ist eine Momentaufnahme zum
letzten erfolgreichen Poll und bezieht sich auf den jüngsten Zeitstempel, nicht auf
die Aktualität sämtlicher Einzelwerte.

### E9 — Instanzmodell: eine Instanz = ein API-Key, n VINs
Ein Quota-Bucket pro Instanz, die konfigurierten VINs teilen ihn sich reihum.
Wer volles Budget pro Fahrzeug will, legt eine zweite Instanz mit eigenem Key an.
**Bewusst nicht gebaut:** mehrere Keys pro Instanz zur Vervielfachung der Quota.
Das umgeht ein Limit, das Škoda absichtlich pro Key zieht.

### E10 — Key-Ablauf: ioBroker-Notification-System plus States
`info.apiKey.expiresAt`, `info.apiKey.daysRemaining`; Log-Eskalation bei 14 / 7 / 2
Tagen; `registerNotification()` in einem eigenen Scope (siehe `io-package.json`
→ `notifications`).
Bei abgelaufenem Key: Polling auf 1×/h drosseln.
`info.connection` wird `false` bei 401/403, **nicht** bei 429 — ein erschöpftes
Budget ist Normalbetrieb.
**Begründung:** Reparatur erfordert zwingend einen Menschen mit dem Handy in der
Hand. Ohne aktive Meldung fällt der Ausfall wochenlang nicht auf, weil alte Werte
laut E8 stehenbleiben.

### E11 — Stack: TypeScript, keine Laufzeitabhängigkeiten
Node ≥ 22 (Node 20 ist seit April 2026 EOL). CI-Matrix 22 und 24. Produktivsystem ist
eine Debian-VM mit Node 22; entwickelt wird auf dem Mac unter Node 26 (bewusste
Entscheidung, siehe Restrisiko 6). Typen generiert aus der eingecheckten Spec. Native `fetch` statt `axios`.
JSON Config statt HTML-Admin. Wöchentlicher CI-Job diffed Škodas Live-Spec gegen
die eingecheckte Kopie.
**Begründung:** Der Antwortbaum ist fünf Ebenen tief und auf jeder Ebene optional —
in JS ist ein `TypeError` auf `undefined` nur eine Frage der Zeit.

### E12 — Teststrategie: Mock-Server plus Unit- und Integrationstests
**Kernpunkt: Gegen die echte API kann man nicht entwickeln.** 20 Requests sind
nach ~20 Minuten Debugging verbraucht. Der Mock ist deshalb das Entwicklungssystem,
nicht bloß Testinfrastruktur. Er muss `RateLimit-*` realistisch mitführen und auf
Kommando `429`, `401`, `422` und Teil-Fehler in `errors[]` erzeugen.
Basis-URL nur über Umgebungsvariable überschreibbar, **nicht** in der Admin-UI.

### E13 — States entstehen nur für tatsächlich gelieferte Teile
Kein Vorab-Anlegen aus der Spec. **Nie automatisch löschen.** Anlage einmal pro
Pfad, danach nur `setStateChanged`.
**Mechanismus:** Ohne `include` liefert die API genau die unterstützten Teile,
schweigend. Das ist die eingebaute Fähigkeitserkennung. `include` spart keine Quota.

### E14 — Datenschutz
Eine `sanitize()`-Funktion in der HTTP-Schicht maskiert VIN und API-Key in **jeder**
Meldung, bevor sie das Modul verlässt. Nie eine Fehlermeldung aus einer rohen URL bauen.
**Begründung:** Die VIN steht im URL-Pfad; ioBroker-Logs landen routinemäßig im Forum.
Zusammen mit `formattedAddress` ergäbe das die Heimatadresse im Klartext.
Parkposition standardmäßig **an**; abschaltbar, und dann via `include` gar nicht
erst angefordert.
Sentry: vorbereitet, aber erst zur Veröffentlichung scharfgeschaltet.

### E15 — Retries differenziert nach Fehlertyp
Siehe Tabelle in `implementation-plan.md`, Abschnitt "Fehlerbehandlung".
Kernregel: **`5xx` verbraucht Quota** → höchstens **ein** Wiederholungsversuch,
mit Jitter, und nur oberhalb der Befehlsreserve. Beide `429` sind gratis → dort
geduldig sein. Ist `Retry-After` länger als die Rest-TTL, Befehl sofort als
`EXPIRED` verwerfen.
**Befehls-States entstehen aus derselben Fähigkeitserkennung wie die Lese-States:**
Fehlt `auxiliaryHeating` in der Antwort, wird kein `auxiliaryHeating.start` angelegt.

### E16 — Listen: ID-basiert auf Profilebene, JSON darunter
`chargingProfiles.profiles.<id>.name` und `.targetStateOfChargeInPercent` als States;
`.timersJson` und `.preferredChargingTimesJson` als JSON-States.
**Begründung:** Index-basiert (`profiles.0`) zeigt nach dem Löschen eines Profils in
der App still auf ein anderes Profil. Die tieferen Ebenen sind read-only und ändern
sich alle paar Monate — ein Objektbaum bringt dort keinen Nutzen, kostet aber
dutzende nie aufgeräumte Objekte.

## Bekannte Restrisiken

1. **Bang-Bang bleibt ein Kompromiss.** Die Wirksamkeit des Überschussladens
   entscheidet sich an der App-Einstellung `REDUCED`, nicht am Adapter.
2. **`429 vehicle-not-accepting-requests` kommt vom Auto**, nicht von der Quota.
   Kann Schaltvorgänge blockieren, obwohl Budget da ist. Von außen nicht vorhersehbar.
3. **API ist `v0`**, Rate-Limit laut Doku ausdrücklich nicht endgültig — in beide
   Richtungen.
4. **Nur der Enyaq ist testbar.** Alles Verbrenner-, Hybrid- und
   Standheizungsspezifische beruht auf Spec plus Mock.
5. **Die Spec hat Fehler.** `Charging` und `ChargingProfile` enthalten je ein Feld
   `tings`, das rekursiv auf den eigenen Typ zeigt — offensichtlich ein
   abgeschnittenes `settings` aus Škodas Generator. Der Codegen braucht dafür eine
   Ausnahme, sonst entsteht eine unendliche Typrekursion.
6. **Entwicklung läuft auf Node 26, Produktion auf Node 22.** Bewusst so
   entschieden (kein Versionsmanager auf dem Mac). Konsequenz: Merkwürdigkeiten im
   `dev-server` müssen erst gegen die Node-Version abgegrenzt werden, bevor man sie
   als Bug behandelt. `js-controller` 7.2.2 deklariert `>=18`, ist gegen Node 26
   aber nicht getestet.
