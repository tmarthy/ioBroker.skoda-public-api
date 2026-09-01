import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const SPEC_PATH = path.join(ROOT, 'spec', 'skoda-openapi.json');
export const SPEC_URL = 'https://public.api.connect.skoda-auto.cz/v3/api-docs';

/**
 * Eigenschaften, die Škodas Spec-Generator fehlerhaft ausgibt: ein abgeschnittenes
 * "settings", das rekursiv auf den eigenen Typ zeigt. Ohne Entfernung erzeugt
 * openapi-typescript eine unendliche Typrekursion.
 * Siehe docs/design-decisions.md, Restrisiko 5.
 */
const BROKEN_PROPERTIES = [
	['Charging', 'tings'],
	['ChargingProfile', 'tings'],
];

/**
 * Laedt die eingecheckte OpenAPI-Spec.
 *
 * @returns {Promise<object>} Das geparste Spec-Dokument.
 */
export async function loadSpec() {
	return JSON.parse(await readFile(SPEC_PATH, 'utf8'));
}

/**
 * Entfernt die bekannten Spec-Fehler und meldet, was tatsächlich entfernt wurde.
 *
 * @param spec Das geparste Spec-Dokument; wird an Ort und Stelle veraendert.
 * @returns {{spec: object, removed: string[]}} Spec und Liste der entfernten Eigenschaften.
 */
export function sanitizeSpec(spec) {
	const removed = [];
	for (const [schemaName, propertyName] of BROKEN_PROPERTIES) {
		const schema = spec.components?.schemas?.[schemaName];
		if (schema?.properties?.[propertyName]) {
			delete schema.properties[propertyName];
			if (Array.isArray(schema.required)) {
				schema.required = schema.required.filter(r => r !== propertyName);
			}
			removed.push(`${schemaName}.${propertyName}`);
		}
	}
	const expected = BROKEN_PROPERTIES.map(([s, p]) => `${s}.${p}`);
	const missing = expected.filter(e => !removed.includes(e));
	if (missing.length > 0) {
		// Kein Abbruch: Wenn Škoda den Fehler behebt, ist das eine gute Nachricht.
		console.warn(`Hinweis: erwarteter Spec-Fehler nicht mehr vorhanden: ${missing.join(', ')}`);
	}
	return { spec, removed };
}
