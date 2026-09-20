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
const API_REDIRECT_PRELOAD = path.join(__dirname, 'preload-api-redirect.js');

/**
 * Routes the official API origin to a local mock entirely from the test process.
 * Production code therefore needs no process-wide environment-variable override.
 *
 * @param {string} baseUrl URL of the local mock.
 * @returns {Record<string, string>} Environment additions for the adapter process.
 */
function adapterEnvironment(baseUrl) {
	return {
		NODE_OPTIONS: `${process.env.NODE_OPTIONS || ''} --require=${API_REDIRECT_PRELOAD}`.trim(),
		SKODA_TEST_API_BASE_URL: baseUrl,
	};
}

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
	await harness.changeAdapterConfig(ADAPTER, {
		// `messagebox` steht in io-package.json und landet bei einer echten
		// Installation ueber `iobroker upload` im Instanzobjekt. Der Testaufbau legt
		// die Instanz mit `iobroker add` an und nimmt die Kennzeichnung nicht mit -
		// ohne sie wird keine Nachricht zugestellt und der Verbindungstest liefe ins Leere.
		common: { enabled: true, messagebox: true },
		native: {
			// @iobroker/testing encrypts fields listed in encryptedNative automatically.
			apiKey: DEFAULT_API_KEY,
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
		require('./compact-suite.js')({ suite, configure, encrypt, getState, setState, readState, waitFor, delay, MockSkodaApi, DEFAULT_API_KEY, DEFAULT_VIN });
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
				mock.vehicleState.charging.settings.availableChargeModes = ['MANUAL', 'TIMER'];
				baseUrl = await mock.start();
				await configure(harness);
				const system = harness.objects.getObjectAsync ? await harness.objects.getObjectAsync('system.config') : await harness.objects.getObject('system.config');
				system.common.language = 'de';
				if (harness.objects.setObjectAsync) { await harness.objects.setObjectAsync('system.config', system); }
				else { await harness.objects.setObject('system.config', system); }

				// Werte eines Vorgaengerprozesses: ein inzwischen fehlendes Feld und
				// ein unveraenderter Wert, dessen alte Fehlerqualitaet verschwinden muss.
				for (const [path, val, q, unit] of [
					['charging.status.chargeType', 'AC', 0],
					['odometer.mileageInKm', 30069, 1],
					['charging.status.battery.remainingCruisingRangeInMeters', 352000, 0, 'm'],
				]) {
					const id = `${VEHICLE}.${path}`;
					const obj = {
						type: 'state',
						common: {
							name: path,
							type: typeof val,
							role: 'state',
							read: true,
							write: false,
							...(unit ? { unit } : {}),
						},
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
				await harness.startAdapterAndWait(true, adapterEnvironment(baseUrl));

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

			it('reports the next poll, successful response time and waiting reason', async function () {
				this.timeout(30000);
				await waitFor('the normal polling schedule', async () =>
					(await getState(harness, `${VEHICLE}.info.polling.reason`))?.val === 'IDLE_INTERVAL');
				const last = await readState(harness, `${VEHICLE}.info.polling.lastSuccessfulPollAt`);
				const next = await readState(harness, `${VEHICLE}.info.polling.nextPollAt`);
				expect(last.val).to.be.greaterThan(Date.now() - 60000);
				expect(next.val).to.be.greaterThan(last.val);
				expect(next.val - last.val).to.be.within(15 * 60000, 15 * 60000 + 10000);
				expect(last.ack).to.equal(true);
				const reasonObject = harness.objects.getObjectAsync ? await harness.objects.getObjectAsync(`${VEHICLE}.info.polling.reason`) : await harness.objects.getObject(`${VEHICLE}.info.polling.reason`);
				expect(reasonObject.common.states.QUOTA).to.equal('Warten auf API-Kontingent');
			});

			it('schreibt Budget und Schluesselablauf aus den Headern', async function () {
				this.timeout(60000);
				const remaining = await readState(harness, `${VEHICLE}.rateLimit.remaining`);
				expect(remaining.val).to.equal(19);
				const limit = await readState(harness, `${VEHICLE}.rateLimit.limit`);
				expect(limit.val).to.equal(20);
				const days = await readState(harness, `${INSTANCE}.info.apiKey.daysRemaining`);
				expect(days.val).to.be.greaterThan(80);
			});

			it('migriert die Reichweite von Metern auf Kilometer', async function () {
				this.timeout(60000);
				const id = `${VEHICLE}.charging.status.battery.remainingCruisingRangeInMeters`;
				await waitFor('die Reichweite in km', async () => (await getState(harness, id))?.val === 352);
				const obj = harness.objects.getObjectAsync
					? await harness.objects.getObjectAsync(id)
					: await harness.objects.getObject(id);
				expect(obj.common.unit).to.equal('km');
				expect(obj.common.name.en).to.equal('Remaining electric range');
				expect(obj.common.name.de).to.equal('Verbleibende elektrische Reichweite');
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
				expect(answer.result).to.contain('Connection established');
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
				await waitFor('waiting command confirmation', async () =>
					(await getState(harness, `${VEHICLE}.info.commandConfirmation.charging.status`))?.val === 'WAITING');
				expect((await readState(harness, `${VEHICLE}.info.commandConfirmation.charging.confirmedAt`)).val).to.equal(0);

				await waitFor('the verification schedule', async () =>
					(await getState(harness, `${VEHICLE}.info.polling.reason`))?.val === 'VERIFICATION');
				expect((await readState(harness, `${VEHICLE}.info.polling.nextPollAt`)).val - Date.now()).to.be.within(0, 60000);

				// `ack: true` heisst "an die API uebergeben", nicht "das Auto hat es
				// getan" (E6) - der Beweis dafuer steht im Mock.
				const enabled = await readState(harness, `${VEHICLE}.charging.enabled`);
				expect(enabled.ack).to.equal(true);
				expect(mock.vehicleState.charging.status.state).to.equal('CHARGING');
			});

			it('setzt das Ladelimit über den neuen numerischen Datenpunkt', async function () {
				this.timeout(30000);
				const id = `${VEHICLE}.charging.settings.targetStateOfChargeInPercent`;
				await setState(harness, id, { val: 90, ack: false });
				await waitFor('die Quittierung des Ladelimits', async () => {
					const state = await getState(harness, id);
					return state?.val === 90 && state.ack === true;
				});
				expect(mock.vehicleState.charging.settings.targetStateOfChargeInPercent).to.equal(90);
				expect(mock.requests.some(request => request.method === 'PUT' && request.path.endsWith('/charging/limit'))).to.equal(true);
			});

			it('sets charging mode and applies staged profile fields with a single PUT', async function () {
				this.timeout(30000);
				const modeId = `${VEHICLE}.charging.settings.preferredChargeMode`;
				await setState(harness, modeId, { val: 'TIMER', ack: false });
				await waitFor('mode acceptance', async () => {
					const state = await getState(harness, modeId);
					return state?.val === 'TIMER' && state.ack === true;
				});
				expect(mock.vehicleState.charging.settings.preferredChargeMode).to.equal('TIMER');
				const profileId = `${VEHICLE}.chargingProfiles.profiles.1.configurationJson`;
				const profile = JSON.parse((await readState(harness, profileId)).val);
				profile.name = 'Updated through ioBroker';
				const editRoot = `${VEHICLE}.chargingProfiles.profiles.1.edit`;
				await waitFor('available profile editor', async () => (await getState(harness, `${editRoot}.available`))?.val === true);
				const fieldObject = harness.objects.getObjectAsync
					? await harness.objects.getObjectAsync(`${editRoot}.timers.1.time`)
					: await harness.objects.getObject(`${editRoot}.timers.1.time`);
				expect(fieldObject.common.role).to.equal('text');
				expect(fieldObject.common.name.de).to.equal('Abfahrtszeit');
				expect(fieldObject.common.desc.de).to.include('Fahrzeug-Ortszeit');
				const beforeEdit = mock.requests.length;
				await setState(harness, `${editRoot}.timers.1.time`, { val: '25:00', ack: false });
				await waitFor('localized validation message', async () => (await getState(harness, `${editRoot}.message`))?.val === 'Ungültiger Wert für timers.1.time.');
				expect(mock.requests).to.have.length(beforeEdit);
				profile.settings.targetStateOfChargeInPercent = 90;
				profile.timers[0].time = '08:15';
				for (const [field, value] of [['name', profile.name], ['settings.targetStateOfChargeInPercent', 90], ['timers.1.time', '08:15']]) {
					await setState(harness, `${editRoot}.${field}`, { val: value, ack: false });
					await waitFor(`staged ${field}`, async () => {
						const state = await getState(harness, `${editRoot}.${field}`);
						return state?.ack === true && state.val === value;
					});
				}
				expect(mock.requests).to.have.length(beforeEdit);
				expect((await readState(harness, `${editRoot}.dirty`)).val).to.equal(true);
				await setState(harness, `${editRoot}.apply`, { val: true, ack: false });
				await waitFor('profile acceptance', async () => {
					const state = await getState(harness, profileId);
					return state?.ack === true && JSON.parse(state.val).name === profile.name;
				});
				expect(mock.vehicleState.chargingProfiles.profiles[0]).to.deep.equal(profile);
				expect(mock.requests).to.have.length(beforeEdit + 1);
				// Simulate newly captured vehicle data for the already scheduled verification poll.
				const captured = new Date(Date.now() + 5).toISOString();
				mock.vehicleState.charging.carCapturedTimestamp = captured;
				mock.vehicleState.chargingProfiles.carCapturedTimestamp = captured;

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
				await waitFor('confirmation from the existing verification poll', async () => {
					for (const group of ['charging', 'chargingLimit', 'chargingMode', 'chargingProfiles.1']) {
						if ((await getState(harness, `${VEHICLE}.info.commandConfirmation.${group}.status`))?.val !== 'CONFIRMED') {
							return false;
						}
					}
					return true;
				});
				expect((await readState(harness, `${VEHICLE}.info.lastCommand.result`)).val).to.equal('SENT');
				const confirmationObject = harness.objects.getObjectAsync ? await harness.objects.getObjectAsync(`${VEHICLE}.info.commandConfirmation.charging.status`) : await harness.objects.getObject(`${VEHICLE}.info.commandConfirmation.charging.status`);
				expect(confirmationObject.common.states.CONFIRMED).to.equal('Passende neuere Fahrzeugdaten erkannt');
				await waitFor('profile draft matches vehicle', async () => (await getState(harness, `${VEHICLE}.chargingProfiles.profiles.1.edit.dirty`))?.val === false);
				expect(mock.requests).to.have.length(7); // Same baseline: 3 GETs, 1 POST and 3 PUTs.
				expect(mock.requests.filter(request => request.method === 'GET')).to.have.length(3);
				expect((await readState(harness, `${VEHICLE}.charging.settings.targetStateOfChargeInPercent`)).val).to.equal(90);
				expect((await readState(harness, `${VEHICLE}.charging.settings.preferredChargeMode`)).val).to.equal('TIMER');
				expect((await readState(harness, `${VEHICLE}.chargingProfiles.profiles.1.name`)).val).to.equal('Updated through ioBroker');
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

				const confirmationId = `${VEHICLE}.info.commandConfirmation.charging.status`;
				const confirmationObject = {
					_id: confirmationId, type: 'state',
					common: { name: 'Confirmation status', type: 'string', role: 'text', read: true, write: false }, native: {},
				};
				if (harness.objects.setObjectAsync) {
					await harness.objects.setObjectAsync(confirmationId, confirmationObject);
				} else {
					await harness.objects.setObject(confirmationId, confirmationObject);
				}
				await setState(harness, confirmationId, { val: 'WAITING', ack: true });

				// So sieht ein Neustart von innen aus: Der Zustand des Vorgaengers
				// steht in <VIN>.rateLimit.*, und der letzte Request liegt eine halbe
				// Minute zurueck.
				await setState(harness, `${VEHICLE}.rateLimit.limit`, { val: 20, ack: true });
				await setState(harness, `${VEHICLE}.rateLimit.remaining`, { val: 8, ack: true });
				await setState(harness, `${VEHICLE}.rateLimit.resetAt`, {
					val: Date.now() + 1800000,
					ack: true,
				});
				await setState(harness, `${VEHICLE}.rateLimit.lastRequestAt`, {
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
				await harness.startAdapter(adapterEnvironment(baseUrl));

				// Der letzte Request liegt weniger als drei Minuten zurueck (Fenster
				// durch Limit). Genau diese Sperrfrist bricht die Neustartschleife,
				// die sonst 20 Requests in 90 Sekunden verbrennt.
				await delay(10000);
				expect(mock.requests, 'Der Adapter hat trotz Sperrfrist gefragt').to.have.length(0);

				const remaining = await readState(harness, `${VEHICLE}.rateLimit.remaining`);
				expect(remaining.val, 'Der Budgetstand hat den Neustart nicht ueberlebt').to.equal(8);
				expect((await readState(harness, `${VEHICLE}.info.commandConfirmation.charging.status`)).val).to.equal('INTERRUPTED');
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
				await harness.startAdapter(adapterEnvironment(baseUrl));

				await waitFor('den Poll mit abgelaufenem Schluessel', () => mock.requests.length > 0);
				expect(mock.requests[0].status).to.equal(401);

				// Anders als nach einem erfolgreichen Poll bleibt die Verbindung unten;
				// gefragt wird ab jetzt nur noch einmal pro Stunde (E10).
				await delay(3000);
				const connection = await readState(harness, `${INSTANCE}.info.connection`);
				expect(connection.val).to.equal(false);
				expect((await readState(harness, `${VEHICLE}.info.polling.reason`)).val).to.equal('AUTH_ERROR');
				expect((await readState(harness, `${VEHICLE}.info.polling.lastSuccessfulPollAt`)).val).to.equal(0);
				expect((await readState(harness, `${VEHICLE}.info.polling.nextPollAt`)).val).to.be.greaterThan(Date.now() + 50 * 60000);

				expect(mock.requests).to.have.length(1);
				// Die Notification selbst laeuft ueber den Host-Prozess, den dieser
				// Testaufbau nicht bereitstellt.
			});
		});
	},
});
