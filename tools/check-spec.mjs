/**
 * Vergleicht die eingecheckte OpenAPI-Spec mit der Live-Spec von Škoda.
 *
 * Die API traegt `version: v0` und die Dokumentation kuendigt Aenderungen ausdruecklich
 * an. Ohne diesen Waechter erfaehrt man von einer Aenderung durch einen Fehlerbericht.
 *
 *   node tools/check-spec.mjs            pruefen, Exit 1 bei Abweichung
 *   node tools/check-spec.mjs --update   eingecheckte Kopie aktualisieren
 */
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { ROOT, SPEC_PATH, SPEC_URL, loadSpec } from './spec.mjs';

const update = process.argv.includes('--update');

const response = await fetch(SPEC_URL, { signal: AbortSignal.timeout(30_000) });
if (!response.ok) {
	console.error(`Live-Spec nicht abrufbar: HTTP ${response.status} ${response.statusText}`);
	process.exit(2);
}
const live = await response.json();
const local = await loadSpec();

/**
 * Flache Liste aller Operationen: "GET /api/v1/vehicles/{vin}".
 *
 * @param spec Das geparste Spec-Dokument.
 * @returns {string[]} Sortierte Liste "METHODE Pfad".
 */
function operations(spec) {
	const out = [];
	for (const [p, ops] of Object.entries(spec.paths ?? {})) {
		for (const method of Object.keys(ops)) {
			out.push(`${method.toUpperCase()} ${p}`);
		}
	}
	return out.sort();
}

/**
 * Flache Liste aller Schema-Eigenschaften: "Charging.status".
 *
 * @param spec Das geparste Spec-Dokument.
 * @returns {string[]} Sortierte Liste "Schema.Eigenschaft".
 */
function properties(spec) {
	const out = [];
	for (const [name, schema] of Object.entries(spec.components?.schemas ?? {})) {
		for (const prop of Object.keys(schema.properties ?? {})) {
			out.push(`${name}.${prop}`);
		}
	}
	return out.sort();
}

function diff(before, after) {
	const removed = before.filter(x => !after.includes(x));
	const added = after.filter(x => !before.includes(x));
	return { removed, added };
}

const identical = JSON.stringify(local) === JSON.stringify(live);
if (identical) {
	console.log('Spec unveraendert.');
	process.exit(0);
}

const ops = diff(operations(local), operations(live));
const props = diff(properties(local), properties(live));

const lines = ['Die MyŠkoda Public API hat sich geaendert.', ''];
if (local.info?.version !== live.info?.version) {
	lines.push(`- Version: \`${local.info?.version}\` -> \`${live.info?.version}\``);
}
for (const [label, set] of [
	['Endpunkt entfernt', ops.removed],
	['Endpunkt neu', ops.added],
	['Eigenschaft entfernt', props.removed],
	['Eigenschaft neu', props.added],
]) {
	for (const entry of set) {
		lines.push(`- ${label}: \`${entry}\``);
	}
}
if (ops.removed.length + ops.added.length + props.removed.length + props.added.length === 0) {
	lines.push('- Keine strukturelle Aenderung an Endpunkten oder Eigenschaften.');
	lines.push('  Betroffen sind nur Beschreibungen, Beispiele oder Reihenfolge.');
	lines.push('  Achtung: Aufzaehlungswerte stehen in Beschreibungen und werden vom Codegen ausgelesen.');
}
lines.push('', 'Naechster Schritt: `node tools/check-spec.mjs --update && npm run codegen`,');
lines.push('danach den Diff in `src/lib/**/,*.generated.ts` pruefen.');

const report = lines.join('\n');
console.log(report);

if (update) {
	await writeFile(SPEC_PATH, `${JSON.stringify(live, null, 2)}\n`, 'utf8');
	console.log(`\n${path.relative(ROOT, SPEC_PATH)} aktualisiert.`);
	process.exit(0);
}

// Fuer die GitHub-Action: Bericht als Datei, damit daraus ein Issue entstehen kann.
if (process.env.GITHUB_ACTIONS) {
	await writeFile(path.join(ROOT, 'spec-diff.md'), `${report}\n`, 'utf8');
}
process.exit(1);
