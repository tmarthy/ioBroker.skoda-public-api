import { expect } from 'chai';
import { createServer, type RequestListener, type Server } from 'node:http';
import { DEFAULT_API_KEY, DEFAULT_VIN, MockSkodaApi, type MockScenario } from '../../../test/mock/server';
import { BASE_URL_ENV_VAR, LIVE_BASE_URL, SkodaApiClient, vehicleErrors } from './client';
import type { ApiErrorKind } from './errors';
import type { VehiclePart } from './types';

/**
 * Die Tests laufen gegen den Mock aus Phase 2, nicht gegen Fixtures: Nur so sind
 * Header, Statuscodes und Antwortkoerper wirklich die einer HTTP-Antwort. Gegen die
 * echte API laesst sich nicht testen - 20 Requests pro Stunde (E12).
 */
describe('api/client => HTTP-Schicht gegen den Mock', () => {
	let mock: MockSkodaApi;
	let client: SkodaApiClient;
	let clock: number;

	beforeEach(async () => {
		clock = Date.parse('2026-09-03T18:00:00Z');
		mock = new MockSkodaApi({ now: () => clock });
		const baseUrl = await mock.start();
		client = new SkodaApiClient({ apiKey: DEFAULT_API_KEY, baseUrl, timeoutMs: 2000 });
	});

	afterEach(async () => {
		await mock.stop();
	});

	describe('Normalbetrieb', () => {
		it('liest das Fahrzeug', async () => {
			const result = await client.getVehicle(DEFAULT_VIN);
			expect(result.ok).to.equal(true);
			if (!result.ok) {
				return;
			}
			expect(result.data.vehicle.vin).to.equal(DEFAULT_VIN);
			expect(result.data.vehicle.charging?.status?.state).to.equal('CONNECT_CABLE');
		});

		it('gibt den Quota-Stand und den Schluesselablauf aus den Headern zurueck', async () => {
			const { meta } = await client.getVehicle(DEFAULT_VIN);
			expect(meta.rateLimit).to.deep.include({ limit: 20, remaining: 19 });
			expect(meta.rateLimit?.resetInSeconds).to.be.closeTo(3600, 2);
			expect(meta.apiKeyExpiresAt).to.be.instanceOf(Date);
			expect(meta.apiKeyExpiresAt?.getTime()).to.be.greaterThan(clock);
			expect(meta.consumedQuota).to.equal(true);
		});

		it('liefert errors gar nicht erst, wenn nichts fehlt - und vehicleErrors faengt das ab', async () => {
			// Fallstrick 10: Die echte API laesst `errors` bei einer fehlerfreien
			// Antwort ganz weg. Ein `data.errors.map(...)` waere hier ein TypeError.
			const result = await client.getVehicle(DEFAULT_VIN);
			expect(result.ok).to.equal(true);
			if (!result.ok) {
				return;
			}
			expect(result.data.errors).to.equal(undefined);
			expect(vehicleErrors(result.data)).to.deep.equal([]);
		});

		it('meldet Teilausfaelle als Erfolg mit Eintraegen in errors', async () => {
			mock.scenario = 'partial-data';
			const result = await client.getVehicle(DEFAULT_VIN);
			expect(result.ok).to.equal(true);
			if (!result.ok) {
				return;
			}
			// 200 mit fehlendem Teil bleibt ein Erfolg - was der StateWriter daraus
			// macht, entscheidet E8, nicht der Client.
			expect(vehicleErrors(result.data).map(e => e.type)).to.deep.equal(['CHARGING_UNAVAILABLE']);
			expect(result.data.vehicle.charging).to.equal(undefined);
		});

		it('reicht include als kommagetrennte Liste durch', async () => {
			const result = await client.getVehicle(DEFAULT_VIN, ['odometer', 'charging']);
			expect(result.ok).to.equal(true);
			if (!result.ok) {
				return;
			}
			expect(Object.keys(result.data.vehicle).sort()).to.deep.equal(['charging', 'odometer', 'vin']);
			expect(mock.requests[0].path).to.contain('include=odometer%2Ccharging');
		});

		it('setzt einen Befehl ab und bekommt 202 ohne Koerper', async () => {
			const result = await client.sendCommand(DEFAULT_VIN, 'charging', 'start');
			expect(result.ok).to.equal(true);
			expect(result.meta.consumedQuota).to.equal(true);
			expect(result.meta.rateLimit?.remaining).to.equal(19);
			expect(mock.vehicleState.charging.status.state).to.equal('CHARGING');
		});

		it('schickt den Koerper mit, wenn der Befehl einen braucht', async () => {
			const result = await client.sendCommand(DEFAULT_VIN, 'air-conditioning', 'start', {
				targetTemperature: { value: 21.5, unit: 'CELSIUS' },
				airConditioningWithoutExternalPower: true,
			});
			expect(result.ok).to.equal(true);
			expect(mock.vehicleState.airConditioning.state).to.equal('HEATING');
		});
	});

	describe('Fehlertabelle gegen echte HTTP-Antworten', () => {
		interface Expectation {
			status: number;
			kind: ApiErrorKind;
			consumesQuota: boolean;
			retryable: boolean;
		}

		const cases: Array<[MockScenario, Expectation]> = [
			['api-key-expired', { status: 401, kind: 'api-key-expired', consumesQuota: false, retryable: false }],
			[
				'api-key-not-authorized',
				{ status: 403, kind: 'api-key-not-authorized', consumesQuota: false, retryable: false },
			],
			[
				'operation-not-authorized',
				{ status: 403, kind: 'operation-not-authorized', consumesQuota: true, retryable: false },
			],
			[
				'operation-not-supported',
				{ status: 422, kind: 'operation-not-supported', consumesQuota: true, retryable: false },
			],
			['operation-disabled', { status: 422, kind: 'operation-disabled', consumesQuota: true, retryable: false }],
			[
				'rate-limit-exceeded',
				{ status: 429, kind: 'rate-limit-exceeded', consumesQuota: false, retryable: true },
			],
			[
				'vehicle-not-accepting-requests',
				{ status: 429, kind: 'vehicle-not-accepting-requests', consumesQuota: false, retryable: true },
			],
			['not-found', { status: 404, kind: 'not-found', consumesQuota: true, retryable: false }],
			['server-error', { status: 500, kind: 'server-error', consumesQuota: true, retryable: true }],
			['service-unavailable', { status: 503, kind: 'server-error', consumesQuota: true, retryable: true }],
			['gateway-timeout', { status: 504, kind: 'server-error', consumesQuota: true, retryable: true }],
		];

		for (const [scenario, expected] of cases) {
			it(`ordnet "${scenario}" der richtigen Zeile zu`, async () => {
				mock.scenario = scenario;
				const result = await client.getVehicle(DEFAULT_VIN);
				expect(result.ok).to.equal(false);
				if (result.ok) {
					return;
				}
				expect(result.error.status, 'status').to.equal(expected.status);
				expect(result.error.kind, 'kind').to.equal(expected.kind);
				expect(result.error.consumesQuota, 'consumesQuota').to.equal(expected.consumesQuota);
				expect(result.error.retryable, 'retryable').to.equal(expected.retryable);
				// Der Quota-Stand steht auf jeder Antwort, auch auf der fehlerhaften.
				expect(result.meta.rateLimit?.limit, 'rateLimit').to.equal(20);
				expect(result.meta.consumedQuota, 'meta.consumedQuota').to.equal(expected.consumesQuota);
			});
		}

		it('erkennt 400 an einem unbekannten include-Wert', async () => {
			const result = await client.getVehicle(DEFAULT_VIN, ['tyrePressure' as VehiclePart]);
			expect(result.ok).to.equal(false);
			if (result.ok) {
				return;
			}
			expect(result.error.status).to.equal(400);
			expect(result.error.kind).to.equal('bad-request');
			expect(result.error.consumesQuota).to.equal(true);
			expect(result.error.retryable).to.equal(false);
		});

		it('meldet einen abgelehnten Befehl als operation-not-supported', async () => {
			// Das Fixture ist ein BEV: keine Standheizung, also auch kein Endpunkt.
			const result = await client.sendCommand(DEFAULT_VIN, 'auxiliary-heating', 'start', { spin: '1234' });
			expect(result.ok).to.equal(false);
			if (result.ok) {
				return;
			}
			expect(result.error.kind).to.equal('operation-not-supported');
			expect(result.error.status).to.equal(422);
		});

		it('uebernimmt Retry-After in Millisekunden', async () => {
			mock.scenario = 'rate-limit-exceeded';
			const quota = await client.getVehicle(DEFAULT_VIN);
			mock.scenario = 'vehicle-not-accepting-requests';
			const vehicle = await client.getVehicle(DEFAULT_VIN);
			expect(quota.ok || vehicle.ok).to.equal(false);
			if (quota.ok || vehicle.ok) {
				return;
			}
			expect(quota.error.retryAfterMs).to.equal(900_000);
			expect(vehicle.error.retryAfterMs).to.equal(120_000);
		});

		it('wiederholt nichts von selbst - ein Aufruf ist genau ein Request', async () => {
			mock.scenario = 'server-error';
			await client.getVehicle(DEFAULT_VIN);
			expect(mock.requests).to.have.length(1);
		});
	});

	describe('Der Client entscheidet nichts ueber das Budget', () => {
		it('fragt auch bei leerem Budget weiter und meldet nur, was die Header sagen', async () => {
			await mock.stop();
			mock = new MockSkodaApi({ now: () => clock, rateLimit: 1 });
			const baseUrl = await mock.start();
			client = new SkodaApiClient({ apiKey: DEFAULT_API_KEY, baseUrl, timeoutMs: 2000 });

			const first = await client.getVehicle(DEFAULT_VIN);
			expect(first.ok).to.equal(true);
			expect(first.meta.rateLimit?.remaining).to.equal(0);

			// Kein Zurueckhalten, keine Warteschlange: Das ist Sache des QuotaManagers
			// aus Phase 4. Der Client setzt den Request ab und meldet das Ergebnis.
			const second = await client.getVehicle(DEFAULT_VIN);
			expect(second.ok).to.equal(false);
			if (second.ok) {
				return;
			}
			expect(second.error.kind).to.equal('rate-limit-exceeded');
			expect(second.meta.consumedQuota).to.equal(false);
			expect(mock.requests).to.have.length(2);
		});
	});

	describe('Datenschutz', () => {
		const SECRET_KEY = 'sk-live-4f2a9c7e1b8d';

		it('nennt in keiner Meldung die VIN oder den Schluessel', async () => {
			const scenarios: MockScenario[] = [
				'api-key-expired',
				'api-key-not-authorized',
				'operation-not-authorized',
				'operation-not-supported',
				'operation-disabled',
				'rate-limit-exceeded',
				'vehicle-not-accepting-requests',
				'not-found',
				'server-error',
				'service-unavailable',
				'gateway-timeout',
			];
			for (const scenario of scenarios) {
				mock.scenario = scenario;
				const result = await client.getVehicle(DEFAULT_VIN);
				expect(result.ok, scenario).to.equal(false);
				if (result.ok) {
					continue;
				}
				const dump = JSON.stringify(result.error);
				expect(dump, `${scenario}: VIN im Klartext`).to.not.contain(DEFAULT_VIN);
				expect(dump, `${scenario}: Schluessel im Klartext`).to.not.contain(DEFAULT_API_KEY);
				expect(result.error.message).to.contain('<VIN>');
			}
		});

		it('maskiert auch, was ein geschwaetziger Server zurueckplappert', async () => {
			// Kein hypothetischer Fall: `instance` ist der URL-Pfad und enthaelt die VIN
			// immer. Hier plappert der Server zusaetzlich den Schluessel nach.
			const talkative = await startServer((req, res) => {
				const echoed = String(req.headers['x-api-key']);
				res.writeHead(403, { 'Content-Type': 'application/problem+json' });
				res.end(
					JSON.stringify({
						type: 'https://public.api.connect.skoda-auto.cz/problems/api-key-not-authorized',
						title: `Schluessel ${echoed} abgelehnt`,
						status: 403,
						detail: `Der Schluessel ${echoed} deckt ${DEFAULT_VIN} nicht ab.`,
						instance: req.url,
					}),
				);
			});
			try {
				const chatty = new SkodaApiClient({ apiKey: SECRET_KEY, baseUrl: talkative.base, timeoutMs: 2000 });
				const result = await chatty.getVehicle(DEFAULT_VIN);
				expect(result.ok).to.equal(false);
				if (result.ok) {
					return;
				}
				const dump = JSON.stringify(result.error);
				expect(dump).to.not.contain(DEFAULT_VIN);
				expect(dump).to.not.contain(SECRET_KEY);
				expect(result.error.message).to.contain('<KEY>').and.to.contain('<VIN>');
			} finally {
				await talkative.close();
			}
		});
	});

	describe('Antworten, auf die kein Verlass ist', () => {
		it('meldet einen Netzwerkfehler und zaehlt ihn konservativ als verbraucht', async () => {
			const port = await freePort();
			const offline = new SkodaApiClient({
				apiKey: DEFAULT_API_KEY,
				baseUrl: `http://127.0.0.1:${port}`,
				timeoutMs: 2000,
			});
			const result = await offline.getVehicle(DEFAULT_VIN);
			expect(result.ok).to.equal(false);
			if (result.ok) {
				return;
			}
			expect(result.error.kind).to.equal('network-error');
			expect(result.error.status).to.equal(undefined);
			expect(result.error.consumesQuota).to.equal(true);
			expect(result.meta.consumedQuota).to.equal(true);
			expect(result.meta.rateLimit).to.equal(undefined);
		});

		it('bricht nach der Zeitgrenze ab und erkennt die Zeitueberschreitung', async () => {
			const silent = await startServer(() => {
				// Antwortet absichtlich nie.
			});
			try {
				const impatient = new SkodaApiClient({
					apiKey: DEFAULT_API_KEY,
					baseUrl: silent.base,
					timeoutMs: 80,
				});
				const result = await impatient.getVehicle(DEFAULT_VIN);
				expect(result.ok).to.equal(false);
				if (result.ok) {
					return;
				}
				expect(result.error.kind).to.equal('network-error');
				expect(result.error.kind === 'network-error' && result.error.timeout).to.equal(true);
			} finally {
				await silent.close();
			}
		});

		it('meldet eine 200-Antwort ohne Fahrzeugdaten als unexpected', async () => {
			const wrong = await startServer((_req, res) => {
				res.writeHead(200, { 'Content-Type': 'application/json' });
				res.end('{"etwas":"anderes"}');
			});
			try {
				const confused = new SkodaApiClient({
					apiKey: DEFAULT_API_KEY,
					baseUrl: wrong.base,
					timeoutMs: 2000,
				});
				const result = await confused.getVehicle(DEFAULT_VIN);
				expect(result.ok).to.equal(false);
				if (result.ok) {
					return;
				}
				expect(result.error.kind).to.equal('unexpected');
				expect(result.error.status).to.equal(200);
				// Angekommen ist die Antwort trotzdem - sie hat gekostet.
				expect(result.meta.consumedQuota).to.equal(true);
			} finally {
				await wrong.close();
			}
		});
	});

	describe('Basis-URL', () => {
		const previous = process.env[BASE_URL_ENV_VAR];

		afterEach(() => {
			if (previous === undefined) {
				delete process.env[BASE_URL_ENV_VAR];
			} else {
				process.env[BASE_URL_ENV_VAR] = previous;
			}
		});

		it('nimmt ohne alles die echte API', () => {
			delete process.env[BASE_URL_ENV_VAR];
			expect(new SkodaApiClient({ apiKey: DEFAULT_API_KEY }).baseUrl).to.equal(LIVE_BASE_URL);
		});

		it('folgt der Umgebungsvariablen - der einzige Weg auf den Mock', () => {
			process.env[BASE_URL_ENV_VAR] = 'http://127.0.0.1:8099/';
			expect(new SkodaApiClient({ apiKey: DEFAULT_API_KEY }).baseUrl).to.equal('http://127.0.0.1:8099');
		});

		it('laesst sich fuer Tests ausdruecklich uebersteuern', () => {
			process.env[BASE_URL_ENV_VAR] = 'http://127.0.0.1:8099';
			const explicit = new SkodaApiClient({ apiKey: DEFAULT_API_KEY, baseUrl: 'http://127.0.0.1:1234' });
			expect(explicit.baseUrl).to.equal('http://127.0.0.1:1234');
		});

		it('faellt bei einer unbrauchbaren URL sofort auf, nicht erst beim Request', () => {
			expect(() => new SkodaApiClient({ apiKey: DEFAULT_API_KEY, baseUrl: 'kein-server' })).to.throw();
		});
	});
});

/**
 * Ein Server fuer die Faelle, die der Mock absichtlich nicht kennt.
 *
 * @param handler Wie auf einen Request geantwortet wird - oder eben nicht.
 * @returns Basis-URL und eine Funktion, die den Server wieder abbaut.
 */
async function startServer(handler: RequestListener): Promise<{ base: string; close: () => Promise<void> }> {
	const server: Server = createServer(handler);
	await new Promise<void>(resolve => server.listen(0, '127.0.0.1', () => resolve()));
	const address = server.address();
	const port = typeof address === 'object' && address ? address.port : 0;
	return {
		base: `http://127.0.0.1:${port}`,
		close: () =>
			new Promise<void>(resolve => {
				// Offene Antworten wuerden das Schliessen sonst blockieren.
				server.closeAllConnections();
				server.close(() => resolve());
			}),
	};
}

/** Ein Port, auf dem sicher nichts lauscht: einmal belegt, wieder freigegeben. */
async function freePort(): Promise<number> {
	const server = await startServer(() => undefined);
	const port = Number(new URL(server.base).port);
	await server.close();
	return port;
}
