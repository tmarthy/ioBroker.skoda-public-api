/** A small, injectable facade around adapter-core's backend translations. */
export type Translate = (key: string, ...args: (string | number | boolean | null)[]) => string;

/**
 * English fallback used by isolated classes and unit tests.
 *
 * Production passes `adapter-core`'s initialized translator instead.
 *
 * @param key Englischer Ausgangstext und Katalogschluessel.
 * @param args Werte fuer die Platzhalter.
 */
export const translateFallback: Translate = (key, ...args) => {
	let text = key;
	for (const arg of args) {
		text = text.replace('%s', arg === null ? 'null' : String(arg));
	}
	return text;
};

/**
 * Creates object metadata which ioBroker can display in either supported language.
 *
 * @param en Englischer Anzeigename.
 * @param de Deutscher Anzeigename.
 */
export function translated(en: string, de: string): ioBroker.Translated {
	return { en, de };
}
