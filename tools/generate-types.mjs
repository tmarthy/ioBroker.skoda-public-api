/**
 * Erzeugt src/lib/api/schema.generated.ts aus spec/skoda-openapi.json.
 * Nicht von Hand editieren - Änderungen gehen beim nächsten `npm run codegen` verloren.
 */
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import openapiTS, { astToString } from 'openapi-typescript';
import { ROOT, loadSpec, sanitizeSpec } from './spec.mjs';

const OUT = path.join(ROOT, 'src', 'lib', 'api', 'schema.generated.ts');

const { spec, removed } = sanitizeSpec(await loadSpec());
if (removed.length > 0) {
	console.log(`Spec bereinigt: ${removed.join(', ')} entfernt (fehlerhafte Rekursion).`);
}

const ast = await openapiTS(spec, { alphabetize: true });
const body = astToString(ast);

const header = [
	'/* eslint-disable */',
	'/**',
	' * GENERIERT - nicht von Hand editieren.',
	' * Quelle: spec/skoda-openapi.json',
	' * Erzeugen mit: npm run codegen',
	' */',
	'',
].join('\n');

await writeFile(OUT, header + body, 'utf8');
console.log(`${path.relative(ROOT, OUT)} geschrieben (${body.length} Zeichen).`);
