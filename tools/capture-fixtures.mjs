/**
 * Nimmt eine echte Antwort der MyŠkoda Public API auf und legt sie anonymisiert
 * als Fixture ab.
 *
 * Schlüssel und VIN kommen aus Umgebungsvariablen und werden nirgends protokolliert.
 * Vor dem Schreiben prüft das Skript, dass weder die echte VIN noch der Schlüssel
 * in der Datei übrig geblieben sind.
 *
 *   SKODA_API_KEY=... SKODA_VIN=... node tools/capture-fixtures.mjs idle
 *
 * Achtung: Jeder Aufruf kostet einen Request aus dem Stundenbudget von 20.
 */
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { ROOT } from './spec.mjs';

const PLACEHOLDER = {
	vin: 'TMBJB9NY5RF999999',
	licensePlate: '1MB 1234',
	name: 'Enyaq',
	formattedAddress: 'Musterstrasse 1, 8000 Zuerich, Schweiz',
	latitude: 47.3769,
	longitude: 8.5417,
	renderUrl: 'https://example.invalid/render/vehicle.png',
};

const name = process.argv[2];
const description = process.argv[3];

if (!name || !/^[a-z0-9-]+$/.test(name)) {
	console.error('Aufruf: SKODA_API_KEY=... SKODA_VIN=... node tools/capture-fixtures.mjs <name> ["Beschreibung"]');
	console.error('Der Name darf nur Kleinbuchstaben, Ziffern und Bindestriche enthalten, z.B. "charging".');
	process.exit(2);
}

const apiKey = process.env.SKODA_API_KEY;
const vin = process.env.SKODA_VIN;
if (!apiKey || !vin) {
	console.error('SKODA_API_KEY und SKODA_VIN muessen gesetzt sein.');
	process.exit(2);
}
if (vin.length !== 17) {
	console.error(`SKODA_VIN muss 17 Zeichen lang sein (ist ${vin.length}).`);
	process.exit(2);
}

/**
 * Ersetzt jedes Vorkommen der echten VIN in beliebig tief verschachtelten Strings.
 *
 * @param value Ein beliebiger JSON-Wert.
 * @param realVin Die zu ersetzende VIN.
 * @returns Der Wert mit ersetzter VIN.
 */
function replaceVinDeep(value, realVin) {
	if (typeof value === 'string') {
		return value.split(realVin).join(PLACEHOLDER.vin);
	}
	if (Array.isArray(value)) {
		return value.map(v => replaceVinDeep(v, realVin));
	}
	if (value && typeof value === 'object') {
		return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, replaceVinDeep(v, realVin)]));
	}
	return value;
}

/**
 * Ersetzt alle personenbeziehbaren Felder durch feste Beispielwerte.
 *
 * @param body Die Antwort der API.
 * @param realVin Die echte VIN, die ueberall ersetzt wird.
 * @returns Die anonymisierte Antwort.
 */
function anonymize(body, realVin) {
	const out = replaceVinDeep(body, realVin);
	const v = out.vehicle;
	if (!v) {
		return out;
	}

	v.vin = PLACEHOLDER.vin;
	if (v.name !== undefined) {
		v.name = PLACEHOLDER.name;
	}
	if (v.licensePlate !== undefined) {
		v.licensePlate = PLACEHOLDER.licensePlate;
	}
	if (v.renderUrl !== undefined) {
		v.renderUrl = PLACEHOLDER.renderUrl;
	}

	const pos = v.parkingPosition;
	if (pos) {
		if (pos.formattedAddress !== undefined) {
			pos.formattedAddress = PLACEHOLDER.formattedAddress;
		}
		if (pos.gpsCoordinates) {
			pos.gpsCoordinates.latitude = PLACEHOLDER.latitude;
			pos.gpsCoordinates.longitude = PLACEHOLDER.longitude;
		}
	}
	return out;
}

const url = `https://public.api.connect.skoda-auto.cz/api/v1/vehicles/${vin}`;
const response = await fetch(url, {
	headers: { 'X-API-Key': apiKey, Accept: 'application/json' },
	signal: AbortSignal.timeout(30_000),
});

// Budget zuerst melden - auch bei Fehlern, denn die meisten kosten Quota.
const limit = response.headers.get('RateLimit-Limit');
const remaining = response.headers.get('RateLimit-Remaining');
const reset = response.headers.get('RateLimit-Reset');
const expiresAt = response.headers.get('X-API-Key-Expires-At');
console.log(`HTTP ${response.status} | Budget: ${remaining ?? '?'} von ${limit ?? '?'} | Reset in ${reset ?? '?'} s`);
if (expiresAt) {
	console.log(`API-Key laeuft ab am ${expiresAt}`);
}

const body = await response.json().catch(() => undefined);

if (!response.ok) {
	console.error('\nAntwort war kein Erfolg, es wird kein Fixture geschrieben.');
	console.error(JSON.stringify(body, null, 2)?.split(vin).join('<VIN>'));
	process.exit(1);
}

const fixture = {
	description: description ?? `Aufnahme "${name}"`,
	note: 'Anonymisiert durch tools/capture-fixtures.mjs. VIN, Kennzeichen, Name, Adresse und Koordinaten sind Beispielwerte.',
	status: response.status,
	body: anonymize(body, vin),
};

// Letzte Sicherung: nichts Echtes darf uebrig sein.
const serialized = JSON.stringify(fixture, null, 2);
for (const [label, secret] of [
	['VIN', vin],
	['API-Key', apiKey],
]) {
	if (serialized.includes(secret)) {
		console.error(`\nABBRUCH: ${label} steht noch im Ergebnis. Fixture wurde NICHT geschrieben.`);
		process.exit(1);
	}
}

const target = path.join(ROOT, 'test', 'fixtures', `vehicle-${name}.json`);
await writeFile(target, `${serialized}\n`, 'utf8');
console.log(`\n${path.relative(ROOT, target)} geschrieben.`);

const parts = Object.keys(fixture.body.vehicle ?? {}).filter(k => k !== 'vin');
console.log(`Enthaltene Teile: ${parts.join(', ')}`);
if (Array.isArray(fixture.body.errors) && fixture.body.errors.length > 0) {
	console.log(`Fehlerliste: ${fixture.body.errors.map(e => e.type).join(', ')}`);
}
