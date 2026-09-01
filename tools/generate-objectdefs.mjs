/**
 * Erzeugt src/lib/states/objectDefs.generated.ts aus spec/skoda-openapi.json.
 *
 * Läuft den Schemabaum unterhalb von `VehicleResponse.vehicle` ab und erzeugt eine
 * flache Abbildung "Punktpfad -> Zustandsdefinition". Die Pfade sind relativ zum
 * Geräteknoten (der VIN), entsprechen also 1:1 der JSON-Struktur der Antwort (E7).
 *
 * Rollen, Einheiten und deutsche Klartext-Labels stehen NICHT hier, sondern in
 * src/lib/states/objectOverlay.ts. Die beiden werden zur Laufzeit zusammengeführt,
 * damit dieser Generator jederzeit neu laufen kann, ohne handgepflegte Werte zu
 * überschreiben.
 */
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { ROOT, loadSpec, sanitizeSpec } from './spec.mjs';

const OUT = path.join(ROOT, 'src', 'lib', 'states', 'objectDefs.generated.ts');

const { spec } = sanitizeSpec(await loadSpec());
const schemas = spec.components.schemas;

/**
 * Löst einen $ref auf den Schemanamen auf.
 *
 * @param node Ein Schemaknoten, moeglicherweise mit $ref.
 * @returns {string|undefined} Der Schemaname, sonst undefined.
 */
function refName(node) {
	return node?.$ref ? node.$ref.split('/').pop() : undefined;
}

function resolve(node) {
	const name = refName(node);
	return name ? { schema: schemas[name], name } : { schema: node, name: undefined };
}

/**
 * Die Spec deklariert die meisten Aufzaehlungen nicht als `enum`, sondern beschreibt
 * sie in Prosa - und zwar in vier verschiedenen Formaten:
 *
 *   1. Aufzaehlungspunkte:  "Possible values are: * OFF * COOLING"
 *   2. Klammerliste:        "Possible values are: [IN_MOTION, PARKED]"
 *   3. Backticks:           "Possible values are `HYBRID`, `GASOLINE` and `UNKNOWN`."
 *   4. Reine Kommaliste:    "Possible value is OPEN, CLOSED, UNKNOWN."
 *
 * Der Parser ist bewusst streng: Er greift nur hinter einer ankuendigenden Wendung,
 * nur bis zum Ende desselben Satzes und akzeptiert nur GROSSBUCHSTABEN_TOKEN.
 * Findet er nichts, entsteht schlicht kein `states` - der harmlose Fall.
 *
 * @param description Die Beschreibung aus der Spec.
 * @returns {string[]|undefined} Die gefundenen Werte, sonst undefined.
 */
function enumFromDescription(description) {
	if (!description) {
		return undefined;
	}
	const anchor = /Possible values? (?:are|is)\s*:?\s*/i.exec(description);
	if (!anchor) {
		return undefined;
	}

	const rest = description.slice(anchor.index + anchor[0].length);

	let segment;
	if (rest.includes('*')) {
		// Format 1: nur das Token direkt hinter dem Stern, nicht dessen Erlaeuterung.
		const tokens = [...rest.matchAll(/\*\s+([A-Z][A-Z0-9_]{1,40})\b/g)].map(m => m[1]);
		return dedupe(tokens);
	}
	const bracket = /\[([^\]]+)\]/.exec(rest);
	if (bracket) {
		segment = bracket[1]; // Format 2
	} else {
		// Format 3 und 4: bis zum Satzende, damit Nachsaetze wie
		// "New values may be added over time" nicht mitgelesen werden.
		segment = rest.split(/\.(?:\s|$)/)[0];
	}
	return dedupe([...segment.matchAll(/\b([A-Z][A-Z0-9_]{1,40})\b/g)].map(m => m[1]));
}

function dedupe(tokens) {
	const unique = [...new Set(tokens)];
	return unique.length >= 2 ? unique : undefined;
}

function enumValues(schema) {
	if (Array.isArray(schema.enum) && schema.enum.length > 0) {
		return schema.enum;
	}
	return enumFromDescription(schema.description);
}

function jsType(schema) {
	switch (schema.type) {
		case 'integer':
		case 'number':
			return 'number';
		case 'boolean':
			return 'boolean';
		default:
			return 'string';
	}
}

function shortDesc(description) {
	if (!description) {
		return undefined;
	}
	const oneLine = description.replace(/\s+/g, ' ').trim();
	const cut = oneLine.split(/Possible values? (are|is)/i)[0].trim();
	return (cut || oneLine).slice(0, 160);
}

const defs = {};
const channels = {};

function walk(node, prefix, seen) {
	const { schema, name } = resolve(node);
	if (!schema) {
		return;
	}
	if (name && seen.includes(name)) {
		return;
	} // Rekursionsschutz
	const nextSeen = name ? [...seen, name] : seen;

	for (const [key, rawProp] of Object.entries(schema.properties ?? {})) {
		const propPath = prefix ? `${prefix}.${key}` : key;
		const { schema: prop, name: propSchemaName } = resolve(rawProp);
		if (!prop) {
			continue;
		}

		if (prop.type === 'array') {
			const itemRef = refName(prop.items);
			if (itemRef) {
				// Objektliste: bekommt eine Sonderbehandlung im StateWriter (E16).
				defs[propPath] = { type: 'string', arrayOf: itemRef, desc: shortDesc(prop.description) };
			} else {
				// Liste primitiver Werte: als JSON-String ablegen.
				defs[propPath] = { type: 'string', isJsonArray: true, desc: shortDesc(prop.description) };
			}
			continue;
		}

		if (prop.properties || propSchemaName) {
			channels[propPath] = shortDesc(prop.description) ?? propSchemaName ?? key;
			walk(rawProp, propPath, nextSeen);
			continue;
		}

		const def = { type: jsType(prop) };
		const values = enumValues(prop);
		if (values) {
			def.states = Object.fromEntries(values.map(v => [v, v]));
		}
		if (prop.format) {
			def.format = prop.format;
		}
		const desc = shortDesc(prop.description);
		if (desc) {
			def.desc = desc;
		}
		defs[propPath] = def;
	}
}

walk({ $ref: '#/components/schemas/Vehicle' }, '', []);

const sortedDefs = Object.fromEntries(Object.entries(defs).sort(([a], [b]) => a.localeCompare(b)));
const sortedChannels = Object.fromEntries(Object.entries(channels).sort(([a], [b]) => a.localeCompare(b)));

const body = `/**
 * GENERIERT - nicht von Hand editieren.
 * Quelle: spec/skoda-openapi.json
 * Erzeugen mit: npm run codegen
 *
 * Pfade sind relativ zum Geraeteknoten (der VIN) und spiegeln die JSON-Struktur
 * der API 1:1 (siehe docs/design-decisions.md, E7).
 */

export interface GeneratedStateDef {
\t/** ioBroker-Datentyp. */
\ttype: 'number' | 'string' | 'boolean';
\t/** Aufzaehlungswerte, sofern die Spec welche nennt - Wert auf Wert abgebildet. */
\tstates?: Record<string, string>;
\t/** OpenAPI-Format, z.B. 'date-time'. */
\tformat?: string;
\t/** Liste primitiver Werte: wird als JSON-String abgelegt. */
\tisJsonArray?: boolean;
\t/** Objektliste: Sonderbehandlung im StateWriter, Wert ist der Schemaname. */
\tarrayOf?: string;
\t/** Gekuerzte Beschreibung aus der Spec. */
\tdesc?: string;
}

/** Zwischenknoten des Objektbaums (ioBroker-Kanaele). */
export const generatedChannels: Record<string, string> = ${JSON.stringify(sortedChannels, null, '\t')};

export const generatedStateDefs: Record<string, GeneratedStateDef> = ${JSON.stringify(sortedDefs, null, '\t')};
`;

await writeFile(OUT, body, 'utf8');

const withStates = Object.values(sortedDefs).filter(d => d.states).length;
const arrays = Object.values(sortedDefs).filter(d => d.arrayOf || d.isJsonArray).length;
console.log(
	`${path.relative(ROOT, OUT)}: ${Object.keys(sortedDefs).length} Zustaende, ` +
		`${Object.keys(sortedChannels).length} Kanaele, ${withStates} mit Aufzaehlung, ${arrays} Listen.`,
);
