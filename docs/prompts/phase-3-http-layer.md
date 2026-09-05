# Prompt — Phase 3: HTTP-Schicht

> Zum Einfügen in eine frische Sitzung. Alles, was diese Phase braucht, steht im Repo;
> der Prompt sagt vor allem, **wo** es steht und was nicht verhandelbar ist.

---

Arbeite im Repository `/Users/thomas/Documents/Dev/ioBroker_skoda/ioBroker.skoda-public-api`.

Das ist ein ioBroker-Adapter für die offizielle MyŠkoda Public API. Die Phasen 0 bis 2
sind abgeschlossen: Projektgerüst, Codegen aus der OpenAPI-Spec, Mock-Server und vier
echte Fahrzeugaufnahmen. **Deine Aufgabe ist Phase 3 — die HTTP-Schicht.**

## Zuerst lesen

1. `HANDOFF.md` — Einstieg, Stand, Umgebung, und in Abschnitt 6 zehn bekannte
   Fallstricke. **Lies die vollständig, bevor du etwas anfasst.** Mehrere davon sind
   Korrekturen, die harmlos aussehen und nicht zurückgedreht werden dürfen.
2. `docs/design-decisions.md` — die Entscheidungen E1–E16 mit Begründung. Für diese
   Phase besonders E8 (unvollständige Antworten), E11 (Stack), E14 (Datenschutz),
   E15 (Retries).
3. `docs/implementation-plan.md` — Abschnitt „Phase 3" und die verbindliche
   **Fehlertabelle** in Abschnitt 5. Die Tabelle ist die Spezifikation dieser Phase.

Die harte Randbedingung des ganzen Projekts: **20 API-Requests pro Stunde und VIN.**
Gegen die echte API lässt sich nicht entwickeln. Alles läuft gegen den Mock.

## Auftrag

Drei Module unter `src/lib/api/`:

**`sanitize.ts`** — ersetzt VIN (`[A-HJ-NPR-Z0-9]{17}`) und den API-Schlüssel in jedem
String durch Platzhalter. Wird auf **jede** Meldung angewandt, die die HTTP-Schicht
erzeugt, bevor sie irgendwohin geht. Grund: Die VIN steht im URL-Pfad, und ioBroker-Logs
landen routinemäßig als Copy-Paste im Forum; zusammen mit `formattedAddress` ergäbe das
die Heimatadresse im Klartext.

**`errors.ts`** — parst `application/problem+json` (RFC 9457) in eine diskriminierte
Union. Jeder Fall trägt mindestens `retryable`, `consumesQuota` und `retryAfterMs`,
gemäß der Fehlertabelle im Plan. Die Problemtypen stehen in der Spec unter
`components.schemas.ProblemDetail`; die beiden `429`-Ursachen lassen sich **nur** am
`type` unterscheiden, nicht am Status und nicht an den `RateLimit-*`-Headern.

**`client.ts`** — `getVehicle(vin, include?)` und `sendCommand(vin, domain, action, body?)`.
Native `fetch`, Timeout über `AbortSignal.timeout()`. Liest `RateLimit-Limit`,
`RateLimit-Remaining`, `RateLimit-Reset` und `X-API-Key-Expires-At` aus **jeder** Antwort
und gibt sie zusammen mit dem Ergebnis zurück.

Vorschlag für die Signatur, gerne begründet abweichen:

```ts
interface ApiMeta {
    rateLimit?: { limit: number; remaining: number; resetInSeconds: number };
    apiKeyExpiresAt?: Date;
    consumedQuota: boolean;
}
type ApiResult<T> = { ok: true; data: T; meta: ApiMeta } | { ok: false; error: ApiError; meta: ApiMeta };
```

## Verbindlich

- **Keine Quota-Entscheidungen im Client.** Er meldet, was die Header sagen, und
  entscheidet nichts. Budgetverwaltung ist Phase 4 (`QuotaManager`), Kadenz ist Phase 6.
  Der Client kennt keine Reserve, keine Queue, keine Wiederholungen über die Zeit.
- **`body.errors ?? []`.** Die echte API lässt `errors` bei fehlerfreier Antwort **ganz
  weg** — entgegen dem Beispiel in Škodas eigener Dokumentation. An vier echten Aufnahmen
  gemessen. Der generierte Typ hat `errors?`, der Compiler erzwingt den Guard also;
  übergehe ihn nicht mit `!`.
- **Zeitstempel nach Millisekunden parsen, nie als Zeichenkette vergleichen.** Beobachtet
  wurden 0, 2, 3 und 9 Nachkommastellen (Nanosekunden).
- **Basis-URL aus der Umgebungsvariablen `SKODA_API_BASE_URL`**, sonst der Live-Wert.
  **Nicht** in die Admin-UI legen — ein sichtbares Feld „API-Server" lädt dazu ein, den
  Adapter samt Schlüssel auf einen fremden Host zeigen zu lassen.
- **Keine neuen Laufzeitabhängigkeiten.** Der Adapter hat genau eine
  (`@iobroker/adapter-core`), und das soll so bleiben.
- Typen ausschließlich aus `src/lib/api/types.ts` beziehen, nie direkt aus
  `schema.generated.ts`.

## Ausdrücklich nicht tun

- Keinen `QuotaManager`, `PollScheduler` oder `CommandQueue` bauen — spätere Phasen.
- `src/main.ts` nicht anfassen; die Generator-Vorlage wird erst in Phase 6 ersetzt.
- Den Mock **nicht** „aufräumen": Dass er `errors` bei leerer Liste weglässt, ist
  gemessenes API-Verhalten, kein Versehen.
- `build/` nicht wieder einchecken (siehe Fallstrick 7).
- Generierte Dateien (`*.generated.ts`) nicht von Hand ändern und nicht wieder unter
  Lint stellen.

## Abnahme

- Unit-Tests decken **jede Zeile der Fehlertabelle** ab — Status, Problemtyp,
  `consumesQuota`, `retryable`.
- Ein Test prüft explizit, dass in **keiner** vom Client erzeugten Meldung VIN oder
  API-Schlüssel auftauchen.
- Die Tests laufen gegen den Mock (`test/mock/server.ts`, programmatisch einbinden wie
  in `test/mock/server.test.ts`), nicht gegen Fixtures allein.
- Grün bleiben müssen: `npm run check`, `npm run lint` (0 Fehler, 0 Warnungen),
  `npm run test` und `npm run build`.

## Arbeitsweise

```bash
npm run mock        # Mock auf 127.0.0.1:8099, Szenarien über /__mock/scenario?value=…
npm run test:ts     # Unit-Tests
npm run check && npm run lint
```

Commits auf Deutsch, Betreffzeile knapp, Rumpf erklärt **warum**. Am Ende pushen
(`git push origin main`) und das CI-Ergebnis mit `gh run watch` prüfen; ein Lauf dauert
5–10 Minuten, Windows ist der Bremsklotz.

Wenn dir beim Bauen etwas auffällt, das eine Entscheidung aus `docs/design-decisions.md`
in Frage stellt: sag es, statt es still anders zu machen.
