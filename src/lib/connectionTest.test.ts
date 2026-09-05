import { expect } from 'chai';
import { DEFAULT_API_KEY, DEFAULT_VIN, MockSkodaApi } from '../../test/mock/server';
import { SkodaApiClient } from './api/client';
import { normalizeVin, pickTestTarget, testConnection } from './connectionTest';
import { QuotaManager } from './quota/QuotaManager';
import { quotaForVehicle } from './quota/VehicleQuotaManager';

describe('connectionTest => ein Request, ein verstaendlicher Satz', () => {
	let clock: number;
	let mock: MockSkodaApi;
	let client: SkodaApiClient;
	const now = (): number => clock;

	beforeEach(async () => {
		clock = Date.parse('2026-09-04T08:00:00Z');
		mock = new MockSkodaApi({ now, keyExpiresInDays: 30 });
		const baseUrl = await mock.start();
		client = new SkodaApiClient({ apiKey: DEFAULT_API_KEY, baseUrl, timeoutMs: 2000 });
	});

	afterEach(async () => {
		await mock.stop();
	});

	describe('Erfolg', () => {
		for (const testedKey of [DEFAULT_API_KEY, 'neuer-schluessel']) {
			it(`bucht den Verbindungstest nur fuer den aktiven Schluessel (${testedKey === DEFAULT_API_KEY ? 'gleich' : 'anders'})`, async () => {
				const quota = new QuotaManager({ now });
				quota.recordResponse({
					consumedQuota: false,
					rateLimit: { limit: 20, remaining: 0, resetInSeconds: 600 },
				});
				let observed = 0;
				let inFlight = -1;
				const result = await testConnection(
					{
						getVehicle: () => {
							inFlight = quota.snapshot().inFlight;
							return Promise.resolve({
								ok: true as const,
								data: { vehicle: {} },
								meta: {
									consumedQuota: true,
									rateLimit: { limit: 20, remaining: 19, resetInSeconds: 3600 },
									apiKeyExpiresAt: new Date(clock + 30 * 86_400_000),
								},
							});
						},
					},
					DEFAULT_VIN,
					clock,
					{
						testedKey,
						activeKey: DEFAULT_API_KEY,
						quota: quotaForVehicle(DEFAULT_VIN, quota),
						onResponse: () => {
							observed++;
						},
					},
				);
				const same = testedKey === DEFAULT_API_KEY;
				expect(result.ok).to.equal(true);
				expect(result.text).to.contain('19 of 20');
				expect(quota.snapshot().remaining).to.equal(same ? 19 : 0);
				expect(quota.snapshot().inFlight).to.equal(0);
				expect(inFlight).to.equal(same ? 1 : 0);
				expect(observed).to.equal(same ? 1 : 0);
			});
		}
		it('nennt das Fahrzeug, den Ablauf und das Budget', async () => {
			const result = await testConnection(client, DEFAULT_VIN, clock);
			expect(result.ok).to.equal(true);
			expect(result.text).to.contain('Enyaq');
			expect(result.text).to.contain('another 30 days');
			expect(result.text).to.contain('19 of 20 requests available');
		});

		it('kostet genau einen Request und fordert nur die Basisangaben an', async () => {
			await testConnection(client, DEFAULT_VIN, clock);
			expect(mock.requests).to.have.length(1);
			// Kein `parkingPosition`: In einem Verbindungstest hat die Adresse des
			// Fahrzeugs nichts zu suchen (E14).
			expect(decodeURIComponent(mock.requests[0].path)).to.contain('include=info');
			expect(decodeURIComponent(mock.requests[0].path)).to.not.contain('parkingPosition');
		});

		it('gibt den Quota-Stand zum Buchen zurueck', async () => {
			const result = await testConnection(client, DEFAULT_VIN, clock);
			expect(result.meta?.consumedQuota).to.equal(true);
			expect(result.meta?.rateLimit?.remaining).to.equal(19);
		});
	});

	describe('Die Faelle, die man sonst nicht auseinanderhaelt', () => {
		it('sagt beim abgelaufenen Schluessel, wo ein neuer herkommt', async () => {
			mock.scenario = 'api-key-expired';
			const result = await testConnection(client, DEFAULT_VIN, clock);
			expect(result.ok).to.equal(false);
			expect(result.text).to.contain('MyŠkoda app');
		});

		it('nennt beim 403 beide moeglichen Ursachen', async () => {
			// Genau der Fall, aus dem sonst niemand schlau wird: derselbe Fehler fuer
			// eine vertippte VIN und fuer ein nicht freigegebenes Fahrzeug.
			const fremd = new SkodaApiClient({ apiKey: 'falscher-schluessel', baseUrl: mock.baseUrl, timeoutMs: 2000 });
			const result = await testConnection(fremd, DEFAULT_VIN, clock);
			expect(result.ok).to.equal(false);
			expect(result.text).to.contain('mistyped');
			expect(result.text).to.contain('not selected');
		});

		it('unterscheidet ein erschoepftes Budget von einem kaputten Schluessel', async () => {
			mock.scenario = 'rate-limit-exceeded';
			const result = await testConnection(client, DEFAULT_VIN, clock);
			expect(result.ok).to.equal(false);
			expect(result.text).to.contain('hourly quota is exhausted');
			expect(result.text).to.contain('key itself is valid');
		});

		it('meldet ein nicht antwortendes Fahrzeug als solches', async () => {
			mock.scenario = 'vehicle-not-accepting-requests';
			const result = await testConnection(client, DEFAULT_VIN, clock);
			expect(result.text).to.contain('vehicle is currently not accepting requests');
		});

		it('meldet eine unbekannte VIN', async () => {
			mock.scenario = 'not-found';
			const result = await testConnection(client, DEFAULT_VIN, clock);
			expect(result.text).to.contain('No vehicle');
		});

		it('meldet eine unerreichbare API', async () => {
			const offline = new SkodaApiClient({
				apiKey: DEFAULT_API_KEY,
				baseUrl: 'http://127.0.0.1:1',
				timeoutMs: 500,
			});
			const result = await testConnection(offline, DEFAULT_VIN, clock);
			expect(result.ok).to.equal(false);
			expect(result.text).to.contain('could not be reached');
		});

		it('nennt in keiner Meldung die VIN oder den Schluessel', async () => {
			for (const scenario of ['api-key-expired', 'not-found', 'server-error'] as const) {
				mock.scenario = scenario;
				const result = await testConnection(client, DEFAULT_VIN, clock);
				expect(result.text, scenario).to.not.contain(DEFAULT_VIN);
				expect(result.text, scenario).to.not.contain(DEFAULT_API_KEY);
			}
		});
	});

	describe('Woher Schluessel und VIN kommen', () => {
		const gespeichert = { apiKey: 'gespeicherter-schluessel', vins: [{ vin: DEFAULT_VIN }] };

		it('nimmt die Werte aus dem Formular, nicht die gespeicherten', () => {
			// Wer gerade einen neuen Schluessel eingetippt hat, will genau den pruefen.
			const target = pickTestTarget({ apiKey: 'neuer-schluessel', vins: [{ vin: DEFAULT_VIN }] }, gespeichert);
			expect(target).to.deep.equal({ apiKey: 'neuer-schluessel', vin: DEFAULT_VIN });
		});

		it('faellt auf die gespeicherte Konfiguration zurueck', () => {
			expect(pickTestTarget({}, gespeichert)).to.deep.equal({
				apiKey: 'gespeicherter-schluessel',
				vin: DEFAULT_VIN,
			});
		});

		it('beanstandet einen fehlenden Schluessel, ohne einen Request zu kosten', () => {
			const target = pickTestTarget({}, { vins: [{ vin: DEFAULT_VIN }] });
			expect(target).to.have.property('problem').that.contains('MyŠkoda app');
		});

		it('beanstandet eine fehlende Fahrzeugliste', () => {
			expect(pickTestTarget({}, { apiKey: 'x' }))
				.to.have.property('problem')
				.that.contains('No vehicle');
		});

		it('nimmt nicht still die zweite Zeile, wenn die erste unbrauchbar ist', () => {
			// Sonst meldet der Test Erfolg fuer ein Fahrzeug, das niemand gemeint hat.
			const target = pickTestTarget({ apiKey: 'x', vins: [{ vin: 'zu-kurz' }, { vin: DEFAULT_VIN }] }, {});
			expect(target).to.have.property('problem').that.contains('first row');
		});
	});

	describe('VIN-Pruefung ohne Request', () => {
		it('nimmt eine gueltige VIN an und schreibt sie gross', () => {
			expect(normalizeVin(` ${DEFAULT_VIN.toLowerCase()} `)).to.equal(DEFAULT_VIN);
		});

		it('lehnt ab, was keine VIN ist', () => {
			expect(normalizeVin('TMBJB9NY5RF9999')).to.equal(undefined);
			expect(normalizeVin('TMBJB9NY5RF99999O')).to.equal(undefined);
			expect(normalizeVin(undefined)).to.equal(undefined);
			expect(normalizeVin(42)).to.equal(undefined);
		});
	});
});
