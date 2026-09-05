'use strict';

const path = require('node:path');
const crypto = require('node:crypto');
const { expect } = require('chai');
const { tests } = require('@iobroker/testing');

// Der Mock ist TypeScript. `npm run test:integration` laeuft ohne die mocha-Konfig
// der Unit-Tests und bringt deshalb keinen Compiler mit - hier einer von Hand.
process.env.TS_NODE_PROJECT = process.env.TS_NODE_PROJECT || 'tsconfig.json';
process.env.TS_NODE_FILES = 'TRUE';
require('ts-node/register');
const { MockSkodaApi, DEFAULT_API_KEY, DEFAULT_VIN } = require('./mock/server');

const ADAPTER = 'skoda-public-api';
const INSTANCE = `${ADAPTER}.0`;
const VEHICLE = `${INSTANCE}.${DEFAULT_VIN}`;

/**
 * Verschluesselt einen Wert so, wie es der js-controller fuer `encryptedNative` tut.
 *
 * Ein Klartextwert im Instanzobjekt wird beim Start entschluesselt und ergibt Unsinn;
 * der Adapter bekaeme dann einen kaputten Schluessel und die API antwortete mit 403.
 *
 * @param {string} secret Systemschluessel aus `system.config`.
 * @param {string} value Der zu verschluesselnde Wert.
 * @returns {string} Der verschluesselte Wert.
 */
function encrypt(secret, value) {
	if (!/^[0-9a-f]{48}$/.test(secret)) {
		// Aeltere Installationen: schlichtes XOR mit dem Systemschluessel.
		let result = '';
		for (let i = 0; i < value.length; i++) {
			result += String.fromCharCode(secret[i % secret.length].charCodeAt(0) ^ value.charCodeAt(i));
		}
		return result;
	}
	const iv = crypto.randomBytes(16);
	const cipher = crypto.createCipheriv('aes-192-cbc', Buffer.from(secret, 'hex'), iv);
	const encrypted = Buffer.concat([cipher.update(value), cipher.final()]);
	return `$/aes-192-cbc:${iv.toString('hex')}:${encrypted.toString('hex')}`;
}

/**
 * Liest einen Zustand aus der Datenbank des Testlaufs.
 *
 * @param {any} harness Der Testaufbau.
 * @param {string} id Vollstaendige Zustands-ID.
 * @returns {Promise<any>} Der Zustand, oder null.
 */
function getState(harness, id) {
	return harness.states.getStateAsync ? harness.states.getStateAsync(id) : harness.states.getState(id);
}

/**
 * Schreibt einen Zustand, wie es ein Nutzer, ein Skript oder ein Vorgaengerprozess taete.
 *
 * @param {any} harness Der Testaufbau.
 * @param {string} id Vollstaendige Zustands-ID.
 * @param {any} state Der zu schreibende Zustand.
 * @returns {Promise<any>} Nichts Brauchbares.
 */
function setState(harness, id, state) {
	return harness.states.setStateAsync ? harness.states.setStateAsync(id, state) : harness.states.setState(id, state);
}

/**
 * Wartet, bis eine Bedingung eintritt - oder die Geduld endet.
 *
 * @param {string} what Was erwartet wird, fuer die Fehlermeldung.
 * @param {() => Promise<boolean>|boolean} check Die Bedingung.
 * @param {number} timeoutMs Wie lange gewartet wird.
 * @returns {Promise<void>} Nichts.
 */
async function waitFor(what, check, timeoutMs = 30000) {
	const until = Date.now() + timeoutMs;
	while (Date.now() < until) {
		if (await check()) {
			return;
		}
		await delay(250);
	}
	throw new Error(`Zeitueberschreitung beim Warten auf: ${what}`);
}

/**
 * Wartet, bis ein Zustand da ist, und liefert ihn.
 *
 * Der Adapter schreibt seinen Objektbaum Zustand fuer Zustand; auf einer langsamen
 * Maschine liegen zwischen dem ersten und dem letzten spuerbar Millisekunden. Wer
 * einen einzelnen davon abfragt, muss auf genau ihn warten.
 *
 * @param {any} harness Der Testaufbau.
 * @param {string} id Vollstaendige Zustands-ID.
 * @param {number} timeoutMs Wie lange gewartet wird.
 * @returns {Promise<any>} Der Zustand.
 */
async function readState(harness, id, timeoutMs = 30000) {
	let state = null;
	await waitFor(
		`den Zustand ${id}`,
		async () => {
			state = await getState(harness, id);
			return state !== null && state !== undefined;
		},
		timeoutMs,
	);
	return state;
}

/**
 * Traegt Schluessel und Fahrzeug in die Instanz ein, wie es die Admin-UI taete.
 *
 * @param {any} harness Der Testaufbau.
 * @returns {Promise<void>} Nichts.
 */
async function configure(harness) {
	const systemConfig = await (harness.objects.getObjectAsync
		? harness.objects.getObjectAsync('system.config')
		: harness.objects.getObject('system.config'));
	const secret = systemConfig && systemConfig.native ? systemConfig.native.secret : '';

	await harness.changeAdapterConfig(ADAPTER, {
		// `messagebox` steht in io-package.json und landet bei einer echten
		// Installation ueber `iobroker upload` im Instanzobjekt. Der Testaufbau legt
		// die Instanz mit `iobroker add` an und nimmt die Kennzeichnung nicht mit -
		// ohne sie wird keine Nachricht zugestellt und der Verbindungstest liefe ins Leere.
		common: { enabled: true, messagebox: true },
		native: {
			apiKey: encrypt(secret, DEFAULT_API_KEY),
			vins: [{ vin: DEFAULT_VIN, label: 'Enyaq' }],
			spin: '',
			pollIntervalIdle: 15,
			pollIntervalActive: 5,
			pollBackoffMax: 60,
			commandReserve: 6,
			commandTtl: 10,
			readParkingPosition: true,
		},
	});
	await harness.enableSendTo();
}

/**
 * Wartet eine Weile.
 *
 * @param {number} ms Wartezeit in Millisekunden.
 * @returns {Promise<void>} Nichts.
 */
function delay(ms) {
	return new Promise(resolve => setTimeout(resolve, ms));
}

tests.integration(path.join(__dirname, '..'), {
	defineAdditionalTests({ suite }) {
		// Jede suite bekommt einen frischen Testaufbau - und der laesst sich genau
		// einmal starten ("This test harness has already been used"). Ein Neustart im
		// laufenden Test ist damit nicht zu haben; deshalb ist jeder Lebenslauf eine
		// eigene suite.
		suite('Lesen, Steuern und Nachfragen gegen den Mock', getHarness => {
			let harness;
			let mock;
			let baseUrl;

			before(async function () {
				this.timeout(120000);
				harness = getHarness();
				mock = new MockSkodaApi();
				baseUrl = await mock.start();
				await configure(harness);

				// Werte eines Vorgaengerprozesses: ein inzwischen fehlendes Feld und
				// ein unveraenderter Wert, dessen alte Fehlerqualitaet verschwinden muss.
				for (const [path, val, q] of [
					['charging.status.chargeType', 'AC', 0],
					['odometer.mileageInKm', 30069, 1],
				]) {
					const id = `${VEHICLE}.${path}`;
					const obj = {
						type: 'state',
						common: { name: path, type: typeof val, role: 'state', read: true, write: false },
						native: {},
					};
					if (harness.objects.setObjectAsync) {
						await harness.objects.setObjectAsync(id, obj);
					} else {
						await harness.objects.setObject(id, obj);
					}
					await setState(harness, id, { val, q, ack: true });
				}
			});

			after(async () => {
				if (mock) {
					await mock.stop();
				}
			});

			it('pollt genau einmal und fuellt den Objektbaum', async function () {
				this.timeout(90000);
				await harness.startAdapterAndWait(true, { SKODA_API_BASE_URL: baseUrl });

				// Ein Start, ein Request. Alles andere waere im Budget nicht zu haben.
				expect(mock.requests).to.have.length(1);
				expect(mock.requests[0].status).to.equal(200);

				// `info.connection` steht schon, sobald die API geantwortet hat - der
				// Objektbaum entsteht danach, Zustand fuer Zustand.
				const odometer = await readState(harness, `${VEHICLE}.odometer.mileageInKm`);
				expect(odometer.val).to.be.a('number');
				const chargingState = await readState(harness, `${VEHICLE}.charging.status.state`);
				expect(chargingState.val).to.equal('CONNECT_CABLE');
				// Der zusaetzliche Zustand aus E7, den die API selbst nicht liefert.
				const position = await readState(harness, `${VEHICLE}.parkingPosition.position`);
				expect(position.val).to.match(/^-?\d+(\.\d+)?;-?\d+(\.\d+)?$/);
			});

			it('schreibt Budget und Schluesselablauf aus den Headern', async function () {
				this.timeout(60000);
				const remaining = await readState(harness, `${INSTANCE}.info.rateLimit.remaining`);
				expect(remaining.val).to.equal(19);
				const limit = await readState(harness, `${INSTANCE}.info.rateLimit.limit`);
				expect(limit.val).to.equal(20);
				const days = await readState(harness, `${INSTANCE}.info.apiKey.daysRemaining`);
				expect(days.val).to.be.greaterThan(80);
			});

			it('korrigiert gespeicherte Qualitaet und markiert verschwundene Felder', async function () {
				this.timeout(60000);
				await waitFor('die Qualitaetsmarkierung nach dem Start', async () => {
					const missing = await getState(harness, `${VEHICLE}.charging.status.chargeType`);
					const current = await getState(harness, `${VEHICLE}.odometer.mileageInKm`);
					return missing && missing.val === 'AC' && missing.q === 1 && current && current.q === 0;
				});
			});

			it('beantwortet den Verbindungstest der Admin-UI', async function () {
				this.timeout(60000);
				const answer = await new Promise(resolve => harness.sendTo(INSTANCE, 'testConnection', {}, resolve));
				expect(answer.error, `Fehler statt Ergebnis: ${answer.error}`).to.equal(undefined);
				expect(answer.result).to.contain('Verbindung steht');
				expect(answer.result).to.contain('Enyaq');
			});

			it('setzt einen Befehl ab und quittiert den Schalter', async function () {
				this.timeout(90000);
				await setState(harness, `${VEHICLE}.charging.enabled`, { val: true, ack: false });

				await waitFor('das Ergebnis des Befehls', async () => {
					const result = await getState(harness, `${VEHICLE}.info.lastCommand.result`);
					return result && result.val === 'SENT';
				});

				const name = await readState(harness, `${VEHICLE}.info.lastCommand.name`);
				expect(name.val).to.equal('charging.start');
				// `ack: true` heisst "an die API uebergeben", nicht "das Auto hat es
				// getan" (E6) - der Beweis dafuer steht im Mock.
				const enabled = await readState(harness, `${VEHICLE}.charging.enabled`);
				expect(enabled.ack).to.equal(true);
				expect(mock.vehicleState.charging.status.state).to.equal('CHARGING');
			});

			it('liest den Ist-Zustand mit dem Verifikations-Poll nach', async function () {
				this.timeout(90000);
				await waitFor(
					'den Verifikations-Poll',
					async () => {
						const state = await getState(harness, `${VEHICLE}.charging.status.state`);
						return state && state.val === 'CHARGING' && state.q === 0;
					},
					85000,
				);
				expect(mock.requests.filter(request => request.method === 'GET')).to.have.length(3);
			});
		});

		suite('Neustart mitten im Quota-Fenster', getHarness => {
			let harness;
			let mock;
			let baseUrl;

			before(async function () {
				this.timeout(120000);
				harness = getHarness();
				mock = new MockSkodaApi();
				baseUrl = await mock.start();
				await configure(harness);

				// So sieht ein Neustart von innen aus: Der Zustand des Vorgaengers
				// steht in info.rateLimit.*, und der letzte Request liegt eine halbe
				// Minute zurueck.
				await setState(harness, `${INSTANCE}.info.rateLimit.limit`, { val: 20, ack: true });
				await setState(harness, `${INSTANCE}.info.rateLimit.remaining`, { val: 8, ack: true });
				await setState(harness, `${INSTANCE}.info.rateLimit.resetAt`, {
					val: Date.now() + 1800000,
					ack: true,
				});
				await setState(harness, `${INSTANCE}.info.rateLimit.lastRequestAt`, {
					val: Date.now() - 30000,
					ack: true,
				});
			});

			after(async () => {
				if (mock) {
					await mock.stop();
				}
			});

			it('haelt die Sperrfrist ein und uebernimmt den Budgetstand', async function () {
				this.timeout(90000);
				await harness.startAdapter({ SKODA_API_BASE_URL: baseUrl });

				// Der letzte Request liegt weniger als drei Minuten zurueck (Fenster
				// durch Limit). Genau diese Sperrfrist bricht die Neustartschleife,
				// die sonst 20 Requests in 90 Sekunden verbrennt.
				await delay(10000);
				expect(mock.requests, 'Der Adapter hat trotz Sperrfrist gefragt').to.have.length(0);

				const remaining = await readState(harness, `${INSTANCE}.info.rateLimit.remaining`);
				expect(remaining.val, 'Der Budgetstand hat den Neustart nicht ueberlebt').to.equal(8);
			});
		});

		suite('Abgelaufener Schluessel', getHarness => {
			let harness;
			let mock;
			let baseUrl;

			before(async function () {
				this.timeout(120000);
				harness = getHarness();
				mock = new MockSkodaApi();
				mock.scenario = 'api-key-expired';
				baseUrl = await mock.start();
				await configure(harness);
			});

			after(async () => {
				if (mock) {
					await mock.stop();
				}
			});

			it('meldet ihn, statt weiter zu fragen', async function () {
				this.timeout(90000);
				await harness.startAdapter({ SKODA_API_BASE_URL: baseUrl });

				await waitFor('den Poll mit abgelaufenem Schluessel', () => mock.requests.length > 0);
				expect(mock.requests[0].status).to.equal(401);

				// Anders als nach einem erfolgreichen Poll bleibt die Verbindung unten;
				// gefragt wird ab jetzt nur noch einmal pro Stunde (E10).
				await delay(3000);
				const connection = await readState(harness, `${INSTANCE}.info.connection`);
				expect(connection.val).to.equal(false);
				expect(mock.requests).to.have.length(1);
				// Die Notification selbst laeuft ueber den Host-Prozess, den dieser
				// Testaufbau nicht hat; sie ist in einer echten Instanz nachgewiesen
				// (siehe HANDOFF.md, Abschnitt 3).
			});
		});
	},
});
