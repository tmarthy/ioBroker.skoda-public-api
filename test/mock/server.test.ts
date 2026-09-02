import { expect } from 'chai';
import { DEFAULT_API_KEY, DEFAULT_VIN, MockSkodaApi, PROBLEM_BASE, type MockScenario } from './server';

/**
 * Der Mock ist das Entwicklungssystem des Adapters (E12). Wenn er sich anders verhaelt
 * als die echte API, baut man den Adapter gegen eine Fiktion. Diese Tests halten
 * deshalb die Eigenschaften fest, auf die sich der Adapter verlassen wird -
 * allen voran die Regel, welche Antworten Quota verbrauchen.
 */
describe('Mock der Skoda-API', () => {
	let mock: MockSkodaApi;
	let base: string;
	let clock: number;

	const vehicleUrl = (query = ''): string => `${base}/api/v1/vehicles/${DEFAULT_VIN}${query}`;
	// `null` heisst "kein Header". Ein `undefined` waere hier eine Falle: bei einem
	// Parameter mit Vorgabewert greift genau dieser Vorgabewert.
	const get = (query = '', key: string | null = DEFAULT_API_KEY): Promise<Response> =>
		fetch(vehicleUrl(query), { headers: key === null ? {} : { 'X-API-Key': key } });
	const post = (pathSuffix: string): Promise<Response> =>
		fetch(`${vehicleUrl()}/${pathSuffix}`, { method: 'POST', headers: { 'X-API-Key': DEFAULT_API_KEY } });

	beforeEach(async () => {
		clock = Date.parse('2026-09-01T18:00:00Z');
		mock = new MockSkodaApi({ now: () => clock });
		base = await mock.start();
	});

	afterEach(async () => {
		await mock.stop();
	});

	describe('Normalbetrieb', () => {
		it('liefert das Fahrzeug samt Quota- und Ablauf-Headern', async () => {
			const res = await get();
			expect(res.status).to.equal(200);
			expect(res.headers.get('RateLimit-Limit')).to.equal('20');
			expect(res.headers.get('RateLimit-Remaining')).to.equal('19');
			expect(Number(res.headers.get('RateLimit-Reset'))).to.be.closeTo(3600, 2);
			expect(res.headers.get('X-API-Key-Expires-At')).to.be.a('string');

			const body = (await res.json()) as any;
			expect(body.vehicle.vin).to.equal(DEFAULT_VIN);
			expect(body.vehicle.charging.status.state).to.equal('CONNECT_CABLE');
			expect(body).to.not.have.property('errors');
		});

		it('laesst errors bei fehlerfreier Antwort ganz weg statt ein leeres Array zu senden', async () => {
			// Am 2026-09-02 an einem echten Enyaq nachgemessen: Die Antwort enthaelt dann
			// nur `vehicle`. Wer `body.errors.map(...)` schreibt, faellt hier auf die Nase -
			// und genau deshalb darf der Mock nicht nachsichtiger sein als die API.
			const body = (await (await get()).json()) as any;
			expect(body).to.not.have.property('errors');
			expect(Object.keys(body)).to.deep.equal(['vehicle']);
		});

		it('sendet errors nur, wenn tatsaechlich etwas fehlt', async () => {
			mock.scenario = 'partial-data';
			const body = (await (await get()).json()) as any;
			expect(body.errors).to.be.an('array').with.length.greaterThan(0);
		});

		it('laesst Teile weg, die das Fahrzeug nicht liefert, ohne sie zu melden', async () => {
			const body = (await (await get()).json()) as any;
			// Das Fixture ist ein BEV: kein Kraftstoff, keine Standheizung.
			expect(body.vehicle).to.not.have.property('fuelStatus');
			expect(body.vehicle).to.not.have.property('auxiliaryHeating');
			expect(body).to.not.have.property('errors');
		});

		it('meldet ausdruecklich angeforderte, nicht unterstuetzte Teile als Fehler', async () => {
			const body = (await (await get('?include=charging,fuelStatus')).json()) as any;
			expect(body.vehicle).to.have.property('charging');
			expect(body.vehicle).to.not.have.property('odometer');
			expect(body.errors.map((e: any) => e.type)).to.deep.equal(['FUEL_STATUS_UNSUPPORTED']);
		});

		it('beschraenkt die Antwort auf die angeforderten Teile', async () => {
			const body = (await (await get('?include=odometer')).json()) as any;
			expect(Object.keys(body.vehicle).sort()).to.deep.equal(['odometer', 'vin']);
		});

		it('weist unbekannte include-Werte mit 400 und Hilfestellung zurueck', async () => {
			const res = await get('?include=odometer,tyrePressure');
			expect(res.status).to.equal(400);
			const body = (await res.json()) as any;
			expect(body.parameter).to.equal('include');
			expect(body.rejectedValue).to.equal('tyrePressure');
			expect(body.allowedValues).to.include('odometer');
		});
	});

	describe('Quota-Buchhaltung', () => {
		it('zaehlt erfolgreiche Antworten herunter', async () => {
			await get();
			await get();
			expect((await get()).headers.get('RateLimit-Remaining')).to.equal('17');
		});

		it('laesst 401 und 403 die Quota unberuehrt', async () => {
			await get(); // verbraucht 1, Rest 19
			const noKey = await get('', null);
			expect(noKey.status).to.equal(401);
			const wrongKey = await get('', 'falsch');
			expect(wrongKey.status).to.equal(403);
			expect(wrongKey.headers.get('RateLimit-Remaining')).to.equal('19');
		});

		it('antwortet bei erschoepftem Budget mit 429 und verbraucht dabei nichts', async () => {
			for (let i = 0; i < 20; i++) {
				await get();
			}
			expect(mock.quota.remaining).to.equal(0);

			const res = await get();
			expect(res.status).to.equal(429);
			const body = (await res.json()) as any;
			expect(body.type).to.equal(`${PROBLEM_BASE}/rate-limit-exceeded`);
			expect(res.headers.get('Retry-After')).to.be.a('string');
			expect(mock.quota.remaining).to.equal(0);
		});

		it('fuellt das Budget nach Ablauf des Fensters wieder auf', async () => {
			for (let i = 0; i < 20; i++) {
				await get();
			}
			expect((await get()).status).to.equal(429);

			clock += 3_600_000;
			const res = await get();
			expect(res.status).to.equal(200);
			expect(res.headers.get('RateLimit-Remaining')).to.equal('19');
		});

		it('verbraucht Quota auch bei 5xx - der teure Fall', async () => {
			mock.scenario = 'service-unavailable';
			const res = await get();
			expect(res.status).to.equal(503);
			expect(res.headers.get('RateLimit-Remaining')).to.equal('19');
		});
	});

	describe('Fehlerfamilien aus der Spec', () => {
		const cases: Array<[MockScenario, number, string | undefined]> = [
			['api-key-expired', 401, 'api-key-expired'],
			['api-key-not-authorized', 403, 'api-key-not-authorized'],
			['operation-not-authorized', 403, 'operation-not-authorized'],
			['operation-not-supported', 422, 'operation-not-supported'],
			['operation-disabled', 422, 'operation-disabled'],
			['rate-limit-exceeded', 429, 'rate-limit-exceeded'],
			['vehicle-not-accepting-requests', 429, 'vehicle-not-accepting-requests'],
			['not-found', 404, undefined],
			['server-error', 500, undefined],
			['service-unavailable', 503, undefined],
			['gateway-timeout', 504, undefined],
		];

		for (const [scenario, status, problem] of cases) {
			it(`liefert fuer "${scenario}" den Status ${status}`, async () => {
				mock.scenario = scenario;
				const res = await get();
				expect(res.status).to.equal(status);
				expect(res.headers.get('Content-Type')).to.contain('application/problem+json');
				const body = (await res.json()) as any;
				expect(body.type).to.equal(problem ? `${PROBLEM_BASE}/${problem}` : 'about:blank');
				expect(body.status).to.equal(status);
			});
		}

		it('unterscheidet die beiden 429-Ursachen am Problemtyp, nicht am Status', async () => {
			mock.scenario = 'vehicle-not-accepting-requests';
			const vehicle = (await (await get()).json()) as any;
			mock.scenario = 'rate-limit-exceeded';
			const quota = (await (await get()).json()) as any;
			expect(vehicle.status).to.equal(quota.status).and.to.equal(429);
			expect(vehicle.type).to.not.equal(quota.type);
		});

		it('liefert bei Teilausfall 200 mit Eintrag in errors[]', async () => {
			mock.scenario = 'partial-data';
			const res = await get();
			expect(res.status).to.equal(200);
			const body = (await res.json()) as any;
			expect(body.vehicle).to.not.have.property('charging');
			expect(body.vehicle).to.have.property('odometer');
			expect(body.errors.map((e: any) => e.type)).to.deep.equal(['CHARGING_UNAVAILABLE']);
		});
	});

	describe('Befehle', () => {
		it('antwortet mit 202 und zeigt die Wirkung erst im naechsten GET', async () => {
			const before = (await (await get()).json()) as any;
			expect(before.vehicle.charging.status.state).to.equal('CONNECT_CABLE');

			const res = await post('charging/start');
			expect(res.status).to.equal(202);
			expect(await res.text()).to.equal('');

			const after = (await (await get()).json()) as any;
			expect(after.vehicle.charging.status.state).to.equal('CHARGING');
		});

		it('verbraucht fuer den Befehl selbst einen Request', async () => {
			const res = await post('charging/stop');
			expect(res.headers.get('RateLimit-Remaining')).to.equal('19');
		});

		it('frischt carCapturedTimestamp auf, damit der Frische-Backoff greift', async () => {
			const before = (await (await get()).json()) as any;
			clock += 60_000;
			await post('air-conditioning/start');
			const after = (await (await get()).json()) as any;
			expect(after.vehicle.airConditioning.carCapturedTimestamp).to.not.equal(
				before.vehicle.airConditioning.carCapturedTimestamp,
			);
		});

		it('lehnt Befehle ab, fuer die das Fahrzeug keinen Datenblock liefert', async () => {
			// Das Fixture ist ein BEV - Standheizung gibt es nicht.
			const res = await post('auxiliary-heating/start');
			expect(res.status).to.equal(422);
			const body = (await res.json()) as any;
			expect(body.type).to.equal(`${PROBLEM_BASE}/operation-not-supported`);
		});
	});

	describe('Verzoegerte Befehlswirkung', () => {
		it('zeigt die Wirkung erst nach Ablauf der eingestellten Verzoegerung', async () => {
			await mock.stop();
			mock = new MockSkodaApi({ now: () => clock, commandLatencyMs: 45_000 });
			base = await mock.start();

			await post('charging/start');
			const immediately = (await (await get()).json()) as any;
			expect(immediately.vehicle.charging.status.state).to.equal('CONNECT_CABLE');

			clock += 46_000;
			const later = (await (await get()).json()) as any;
			expect(later.vehicle.charging.status.state).to.equal('CHARGING');
		});
	});

	describe('Verlauf', () => {
		it('protokolliert Methode, Status und Quota-Verbrauch je Request', async () => {
			await get();
			await get('', 'falsch');
			expect(mock.requests).to.have.length(2);
			expect(mock.requests[0]).to.include({ method: 'GET', status: 200, consumedQuota: true });
			expect(mock.requests[1]).to.include({ status: 403, consumedQuota: false });
		});
	});
});
