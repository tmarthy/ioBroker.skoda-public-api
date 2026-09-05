/**
 * Maskierung von VIN und API-Schluessel in jeder Meldung, welche die HTTP-Schicht
 * erzeugt (siehe docs/design-decisions.md, E14).
 *
 * Die VIN steht im URL-Pfad und taucht damit unaufgefordert in jeder
 * `problem+json`-Antwort wieder auf - das Feld `instance` ist genau dieser Pfad.
 * ioBroker-Logs landen routinemaessig als Copy-Paste im Forum; zusammen mit
 * `formattedAddress` aus der Parkposition ergaebe das die Heimatadresse im Klartext.
 *
 * Deshalb gilt: **Nie eine Meldung aus einer rohen URL bauen**, und jede Zeichenkette,
 * die `errors.ts` oder `client.ts` erzeugen, laeuft vorher durch diese Datei.
 */

/** Platzhalter, der an die Stelle einer Fahrgestellnummer tritt. */
export const VIN_PLACEHOLDER = '<VIN>';

/** Platzhalter fuer den API-Schluessel und alle weiteren hinterlegten Geheimnisse. */
export const SECRET_PLACEHOLDER = '<KEY>';

/**
 * VIN nach ISO 3779: 17 Zeichen ohne I, O und Q - die sind ausgeschlossen, damit sie
 * nicht mit 1 und 0 verwechselt werden.
 *
 * Die Lookarounds ersetzen ein `\b`: Sie verhindern einen Treffer mitten in einer
 * laengeren Kennung (ein 18-stelliger Bezeichner ist keine VIN), lassen aber `/`, `_`
 * und Anfuehrungszeichen als Nachbarn zu - genau so steht die VIN im URL-Pfad und in
 * JSON.
 */
const VIN_PATTERN = /(?<![A-Za-z0-9])[A-HJ-NPR-Z0-9]{17}(?![A-Za-z0-9])/g;

/**
 * Kuerzere Geheimnisse werden nicht maskiert. Ein versehentlich leerer oder
 * einstelliger Schluessel aus der Instanzkonfiguration wuerde sonst jede Meldung in
 * einen Teppich aus Platzhaltern verwandeln - unlesbar, und der Schluessel waere
 * ohnehin keiner.
 */
const MIN_SECRET_LENGTH = 8;

/** Wie tief die `cause`-Kette eines Fehlers verfolgt wird. */
const MAX_CAUSE_DEPTH = 4;

/** Was ausser der VIN maskiert werden soll. */
export interface SanitizeOptions {
	/** Der API-Schluessel dieser Instanz. */
	apiKey?: string;
	/** Weitere Zeichenketten, die in keiner Meldung stehen duerfen, z.B. der S-PIN. */
	secrets?: readonly string[];
}

/**
 * Macht aus einem beliebigen Wert eine Zeichenkette, ohne das zu verlieren, was zur
 * Diagnose taugt.
 *
 * Bei einem Fehler ist das vor allem die `cause`-Kette: `fetch` meldet selbst nur
 * "fetch failed" und haengt den eigentlichen Grund (`ECONNREFUSED`, `ENOTFOUND`) als
 * Ursache an.
 *
 * @param value Der umzuwandelnde Wert.
 * @param depth Aktuelle Tiefe in der `cause`-Kette.
 * @returns Eine Zeichenkette, noch **ohne** Maskierung.
 */
function stringify(value: unknown, depth = 0): string {
	if (typeof value === 'string') {
		return value;
	}
	if (value instanceof Error) {
		const head = value.message ? `${value.name}: ${value.message}` : value.name;
		if (value.cause !== undefined && depth < MAX_CAUSE_DEPTH) {
			return `${head} (cause: ${stringify(value.cause, depth + 1)})`;
		}
		return head;
	}
	if (value === null || typeof value !== 'object') {
		return String(value);
	}
	try {
		return JSON.stringify(value) ?? '[not printable]';
	} catch {
		return '[not printable]';
	}
}

/**
 * Sammelt die zu maskierenden Geheimnisse, laengste zuerst.
 *
 * Die Reihenfolge zaehlt: Ist ein Geheimnis Praefix eines anderen, wuerde die kuerzere
 * Ersetzung das laengere zerschneiden und dessen Rest stehen lassen.
 *
 * @param options Schluessel und weitere Geheimnisse.
 * @returns Die brauchbaren Geheimnisse, absteigend nach Laenge.
 */
function collectSecrets(options: SanitizeOptions): string[] {
	return [options.apiKey, ...(options.secrets ?? [])]
		.filter((secret): secret is string => typeof secret === 'string' && secret.length >= MIN_SECRET_LENGTH)
		.sort((a, b) => b.length - a.length);
}

/**
 * Maskiert VIN und Geheimnisse in einem beliebigen Wert.
 *
 * @param value Meldung, Fehler oder sonstiger Wert.
 * @param options Schluessel und weitere Geheimnisse; ohne sie wird nur die VIN maskiert.
 * @returns Die Zeichenkette mit `<VIN>` und `<KEY>` an den betroffenen Stellen.
 */
export function sanitize(value: unknown, options: SanitizeOptions = {}): string {
	let text = stringify(value);
	// Geheimnisse zuerst: Ein 17-stelliger Schluessel wuerde sonst als VIN maskiert -
	// harmlos, aber die Meldung wuerde in die Irre fuehren.
	for (const secret of collectSecrets(options)) {
		text = text.split(secret).join(SECRET_PLACEHOLDER);
	}
	return text.replace(VIN_PATTERN, VIN_PLACEHOLDER);
}

/** Eine an feste Geheimnisse gebundene Maskierung. */
export type Sanitizer = (value: unknown) => string;

/**
 * Bindet `sanitize()` an die Geheimnisse einer Instanz.
 *
 * Der Client reicht das Ergebnis an `errors.ts` weiter, damit dort keine Meldung
 * entstehen kann, die den Schluessel noch enthaelt.
 *
 * @param options Schluessel und weitere Geheimnisse.
 * @returns Eine Funktion, die jeden Wert maskiert in eine Zeichenkette wandelt.
 */
export function createSanitizer(options: SanitizeOptions = {}): Sanitizer {
	return value => sanitize(value, options);
}
