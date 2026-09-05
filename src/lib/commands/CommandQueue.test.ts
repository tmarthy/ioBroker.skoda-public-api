import { expect } from 'chai';
import { DEFAULT_API_KEY, DEFAULT_VIN, MockSkodaApi } from '../../../test/mock/server';
import { SkodaApiClient, type ApiResult } from '../api/client';
import type { CommandAction, CommandDomain } from '../api/types';
import { httpApiError } from '../api/errors';
import { QuotaManager } from '../quota/QuotaManager';
import type { CommandReport } from '../states/commandDefs';
import { CommandQueue, type CommandLog, type CommandSender } from './CommandQueue';
import type { CommandBody } from './commandMap';

const MINUTE = 60_000;

/** Ein Log, das nichts ausgibt, aber alles behaelt. */
class RecordingLog implements CommandLog {
	public readonly lines: string[] = [];

	public debug(message: string): void {
		this.lines.push(`debug ${message}`);
	}
	public info(message: string): void {
		this.lines.push(`info ${message}`);
	}
	public warn(message: string): void {
		this.lines.push(`warn ${message}`);
	}
	public error(message: string): void {
		this.lines.push(`error ${message}`);
	}
}

describe('commands/CommandQueue => Soll-Zustand, Coalescing, TTL', () => {
	let clock: number;
	let mock: MockSkodaApi;
	let client: SkodaApiClient;
	let quota: QuotaManager;
	let log: RecordingLog;
	let reports: Array<[string, CommandReport]>;
	let verified: string[];
	let queue: CommandQueue;

	const now = (): number => clock;
	const results = (): string[] => reports.map(([, report]) => report.result);
	const last = (): CommandReport => reports[reports.length - 1][1];

	/**
	 * Baut eine Queue mit dem Mock als Gegenstelle.
	 *
	 * @param options Abweichungen von der Vorgabe.
	 * @returns Die Queue.
	 */
	const buildQueue = (options: Partial<ConstructorParameters<typeof CommandQueue>[0]> = {}): CommandQueue =>
		new CommandQueue({
			client,
			quota,
			vins: [DEFAULT_VIN],
			onReport: (vin, report) => {
				reports.push([vin, report]);
			},
			onCommandSent: vin => verified.push(vin),
			log,
			now,
			random: () => 0.5,
			...options,
		});

	/** Der Zustand, den der Mock gerade liefert - so kommt die Queue an ihr Ist. */
	const feedPoll = async (): Promise<void> => {
		const result = await client.getVehicle(DEFAULT_VIN);
		quota.recordResponse(result.meta);
		if (result.ok) {
			queue.updateFromResponse(DEFAULT_VIN, result.data);
		}
	};

	beforeEach(async () => {
		clock = Date.parse('2026-09-04T08:00:00Z');
		mock = new MockSkodaApi({ now });
		const baseUrl = await mock.start();
		client = new SkodaApiClient({ apiKey: DEFAULT_API_KEY, baseUrl, timeoutMs: 2000 });
		quota = new QuotaManager({ now });
		log = new RecordingLog();
		reports = [];
		verified = [];
		queue = buildQueue();
	});

	afterEach(async () => {
		queue.stop();
		await mock.stop();
	});

	describe('Absetzen', () => {
		it('setzt einen Befehl ab und quittiert den Schalter', async () => {
			await queue.submit(`${DEFAULT_VIN}.charging.enabled`, true);

			expect(results()).to.deep.equal(['SENT']);
			expect(last().name).to.equal('charging.start');
			// ack heisst "an die API uebergeben", nicht "das Auto hat es getan" (E6).
			expect(last().acknowledge).to.deep.equal({ path: 'charging.enabled', value: true });
			expect(mock.vehicleState.charging.status.state).to.equal('CHARGING');
		});

		it('stoesst danach den Verifikations-Poll an', async () => {
			await queue.submit(`${DEFAULT_VIN}.charging.enabled`, true);
			expect(verified).to.deep.equal([DEFAULT_VIN]);
		});

		it('setzt den Knopf nach dem Absetzen zurueck', async () => {
			await queue.submit(`${DEFAULT_VIN}.charging.start`, true);
			expect(last().acknowledge).to.deep.equal({ path: 'charging.start', value: false });
		});

		it('zieht den Request aus dem Budget', async () => {
			await queue.submit(`${DEFAULT_VIN}.charging.enabled`, true);
			expect(quota.snapshot().remaining).to.equal(19);
		});

		it('reicht die Antwort fuer den Schluesselablauf weiter', async () => {
			const seen: Array<string | undefined> = [];
			queue = buildQueue({ onResponse: (_meta, error) => seen.push(error?.kind) });

			await queue.submit(`${DEFAULT_VIN}.charging.enabled`, true);
			mock.scenario = 'api-key-expired';
			await queue.submit(`${DEFAULT_VIN}.charging.enabled`, false);

			expect(seen).to.deep.equal([undefined, 'api-key-expired']);
		});

		it('ignoriert Zustaende fremder Fahrzeuge', async () => {
			await queue.submit('TMBJC1NY0SF123456.charging.enabled', true);
			expect(reports).to.have.length(0);
			expect(mock.requests).to.have.length(0);
		});
	});

	describe('Idempotenz', () => {
		it('laesst einen unbestaetigten Wunsch nach der TTL erneut senden', async () => {
			await queue.submit(`${DEFAULT_VIN}.charging.enabled`, true);
			clock += 11 * MINUTE;
			queue.updateFromResponse(DEFAULT_VIN, {
				vehicle: {
					charging: {
						isVehicleInSavedLocation: false,
						carCapturedTimestamp: new Date(clock).toISOString(),
						status: { state: 'READY_FOR_CHARGING' },
					},
				},
			});
			await queue.submit(`${DEFAULT_VIN}.charging.enabled`, true);
			expect(results()).to.deep.equal(['SENT', 'SENT']);
		});

		it('verwendet nach Ablauf ohne neue Daten nicht den Ist vor dem POST', async () => {
			await feedPoll();
			await queue.submit(`${DEFAULT_VIN}.charging.enabled`, true);
			clock += 11 * MINUTE;
			await queue.submit(`${DEFAULT_VIN}.charging.enabled`, false);
			expect(results()).to.deep.equal(['SENT', 'SENT']);
		});

		it('unterdrueckt doppelte Wuensche nur waehrend der Bestaetigungsfrist', async () => {
			await queue.submit(`${DEFAULT_VIN}.charging.enabled`, true);
			clock += MINUTE;
			queue.updateFromResponse(DEFAULT_VIN, {
				vehicle: {
					charging: {
						isVehicleInSavedLocation: false,
						carCapturedTimestamp: new Date(clock).toISOString(),
						status: { state: 'READY_FOR_CHARGING' },
					},
				},
			});
			await queue.submit(`${DEFAULT_VIN}.charging.enabled`, true);
			expect(results()).to.deep.equal(['SENT', 'COALESCED']);
		});

		it('loest einen bestaetigten Wunsch auf und beachtet spaetere Ist-Aenderungen', async () => {
			await queue.submit(`${DEFAULT_VIN}.charging.enabled`, true);
			clock += MINUTE;
			queue.updateFromResponse(DEFAULT_VIN, {
				vehicle: {
					charging: {
						isVehicleInSavedLocation: false,
						carCapturedTimestamp: new Date(clock).toISOString(),
						status: { state: 'CHARGING' },
					},
				},
			});
			clock += MINUTE;
			queue.updateFromResponse(DEFAULT_VIN, {
				vehicle: {
					charging: {
						isVehicleInSavedLocation: false,
						carCapturedTimestamp: new Date(clock).toISOString(),
						status: { state: 'READY_FOR_CHARGING' },
					},
				},
			});
			await queue.submit(`${DEFAULT_VIN}.charging.enabled`, true);
			expect(results()).to.deep.equal(['SENT', 'SENT']);
		});

		it('akzeptiert keine veralteten Daten als Bestaetigung', async () => {
			await queue.submit(`${DEFAULT_VIN}.charging.enabled`, true);
			queue.updateFromResponse(DEFAULT_VIN, {
				vehicle: {
					charging: {
						isVehicleInSavedLocation: false,
						carCapturedTimestamp: new Date(clock - MINUTE).toISOString(),
						status: { state: 'CHARGING' },
					},
				},
			});
			clock += MINUTE;
			queue.updateFromResponse(DEFAULT_VIN, {
				vehicle: {
					charging: {
						isVehicleInSavedLocation: false,
						carCapturedTimestamp: new Date(clock).toISOString(),
						status: { state: 'READY_FOR_CHARGING' },
					},
				},
			});
			await queue.submit(`${DEFAULT_VIN}.charging.enabled`, true);
			expect(results()).to.deep.equal(['SENT', 'COALESCED']);
		});
		it('sendet nichts, wenn der Soll dem Ist entspricht', async () => {
			await feedPoll();
			// Das Fixture steht auf CONNECT_CABLE, laedt also nicht.
			await queue.submit(`${DEFAULT_VIN}.charging.enabled`, false);

			expect(results()).to.deep.equal(['COALESCED']);
			expect(mock.requests.filter(r => r.method === 'POST')).to.have.length(0);
		});

		it('sendet doch, wenn der Knopf gedrueckt wird', async () => {
			await feedPoll();
			// Der Knopf ist der Ausweg, wenn die gepollten Daten nicht mehr stimmen.
			await queue.submit(`${DEFAULT_VIN}.charging.stop`, true);
			expect(results()).to.deep.equal(['SENT']);
		});

		it('sendet, solange es noch keine gepollten Daten gibt', async () => {
			// Ohne Ist-Zustand wird nicht geraten.
			await queue.submit(`${DEFAULT_VIN}.charging.enabled`, false);
			expect(results()).to.deep.equal(['SENT']);
		});
	});

	describe('Coalescing und Budget', () => {
		/** Bringt das Budget auf null, ohne den Mock zu befragen. */
		const exhaustQuota = (): void => {
			quota.recordResponse({ rateLimit: { limit: 20, remaining: 0, resetInSeconds: 300 }, consumedQuota: true });
		};

		it('meldet QUEUED, wenn kein Budget da ist', async () => {
			exhaustQuota();
			await queue.submit(`${DEFAULT_VIN}.charging.enabled`, true);

			expect(results()).to.deep.equal(['QUEUED']);
			expect(mock.requests).to.have.length(0);
			expect(queue.pending).to.equal(1);
		});

		it('setzt den wartenden Befehl ab, sobald sich das Fenster oeffnet', async () => {
			exhaustQuota();
			await queue.submit(`${DEFAULT_VIN}.charging.enabled`, true);

			clock += 301_000;
			await queue.tick();

			expect(results()).to.deep.equal(['QUEUED', 'SENT']);
			expect(mock.vehicleState.charging.status.state).to.equal('CHARGING');
		});

		it('laesst den wartenden Befehl ersatzlos verfallen, wenn der Soll zum Ist wird', async () => {
			// Das Abnahmekriterium der Phase: enabled=true, dann innerhalb der TTL
			// enabled=false - null Requests, Ergebnis COALESCED.
			await feedPoll();
			exhaustQuota();

			await queue.submit(`${DEFAULT_VIN}.charging.enabled`, true);
			expect(queue.pending).to.equal(1);

			clock += 2 * MINUTE;
			await queue.submit(`${DEFAULT_VIN}.charging.enabled`, false);

			expect(results()).to.deep.equal(['QUEUED', 'COALESCED']);
			expect(queue.pending).to.equal(0);
			expect(mock.requests.filter(r => r.method === 'POST')).to.have.length(0);
		});

		it('ersetzt den wartenden Befehl derselben Domaene, statt zwei zu sammeln', async () => {
			await feedPoll();
			exhaustQuota();

			await queue.submit(`${DEFAULT_VIN}.charging.enabled`, true);
			await queue.submit(`${DEFAULT_VIN}.charging.start`, true);
			expect(queue.pending).to.equal(1);

			clock += 301_000;
			await queue.tick();
			expect(mock.requests.filter(r => r.method === 'POST')).to.have.length(1);
		});

		it('haelt Befehle verschiedener Domaenen auseinander', async () => {
			exhaustQuota();
			await queue.submit(`${DEFAULT_VIN}.charging.enabled`, true);
			await queue.submit(`${DEFAULT_VIN}.airConditioning.enabled`, true);
			expect(queue.pending).to.equal(2);
		});

		it('behaelt einen Gegenbefehl, der waehrend des ersten POST eintrifft', async () => {
			let releaseFirst: (() => void) | undefined;
			const sent: CommandAction[] = [];
			const stub: CommandSender = {
				sendCommand: (_vin, _domain, action): Promise<ApiResult<void>> => {
					sent.push(action);
					if (sent.length > 1) {
						return Promise.resolve({ ok: true, data: undefined, meta: { consumedQuota: true } });
					}
					return new Promise(resolve => {
						releaseFirst = () => resolve({ ok: true, data: undefined, meta: { consumedQuota: true } });
					});
				},
			};
			queue = buildQueue({ client: stub });

			const first = queue.submit(`${DEFAULT_VIN}.charging.start`, true);
			while (!releaseFirst) {
				await new Promise<void>(resolve => setImmediate(resolve));
			}
			const second = queue.submit(`${DEFAULT_VIN}.charging.stop`, true);
			releaseFirst();
			await Promise.all([first, second]);

			expect(sent).to.deep.equal(['start', 'stop']);
			expect(queue.pending).to.equal(0);
		});

		it('coalesct einen Gegenwunsch nicht gegen den Ist-Zustand vor dem laufenden POST', async () => {
			let releaseFirst: (() => void) | undefined;
			const sent: CommandAction[] = [];
			const stub: CommandSender = {
				sendCommand: (_vin, _domain, action): Promise<ApiResult<void>> => {
					sent.push(action);
					if (sent.length > 1) {
						return Promise.resolve({ ok: true, data: undefined, meta: { consumedQuota: true } });
					}
					return new Promise(resolve => {
						releaseFirst = () => resolve({ ok: true, data: undefined, meta: { consumedQuota: true } });
					});
				},
			};
			queue = buildQueue({ client: stub });
			const poll = await client.getVehicle(DEFAULT_VIN);
			if (poll.ok) {
				queue.updateFromResponse(DEFAULT_VIN, poll.data);
			}

			const first = queue.submit(`${DEFAULT_VIN}.charging.enabled`, true);
			while (!releaseFirst) {
				await new Promise<void>(resolve => setImmediate(resolve));
			}
			// Der letzte Poll meldet noch "aus". Trotzdem muss dieser neuere Wunsch
			// den gerade laufenden Start wieder aufheben.
			const second = queue.submit(`${DEFAULT_VIN}.charging.enabled`, false);
			releaseFirst();
			await Promise.all([first, second]);

			expect(sent).to.deep.equal(['start', 'stop']);
			expect(results()).to.deep.equal(['SENT', 'SENT']);
		});

		it('behaelt den Gegenwunsch auch nach 202 bis zum bestaetigenden Poll', async () => {
			await feedPoll();
			// Der gepufferte Poll steht auf "aus". Der Mock nimmt den Start sofort an,
			// aber die Queue erfaehrt den neuen Ist erst beim Verifikations-Poll.
			await queue.submit(`${DEFAULT_VIN}.charging.enabled`, true);
			await queue.submit(`${DEFAULT_VIN}.charging.enabled`, false);

			const posts = mock.requests.filter(request => request.method === 'POST');
			expect(posts.map(request => request.path)).to.deep.equal([
				`/api/v1/vehicles/${DEFAULT_VIN}/charging/start`,
				`/api/v1/vehicles/${DEFAULT_VIN}/charging/stop`,
			]);
			expect(results()).to.deep.equal(['SENT', 'SENT']);
		});
	});

	describe('Lebensdauer', () => {
		it('verwirft einen Befehl, der die Lebensdauer ueberschritten hat', async () => {
			quota.recordResponse({ rateLimit: { limit: 20, remaining: 0, resetInSeconds: 300 }, consumedQuota: true });
			await queue.submit(`${DEFAULT_VIN}.charging.enabled`, true);

			clock += 11 * MINUTE;
			await queue.tick();

			expect(results()).to.deep.equal(['QUEUED', 'EXPIRED']);
			expect(queue.pending).to.equal(0);
		});

		it('verwirft sofort, wenn das Budget erst nach der Lebensdauer aufgeht', async () => {
			// Eine Stunde warten fuer einen Befehl, den in zehn Minuten niemand mehr
			// will - dann lieber jetzt ehrlich verwerfen (E15).
			quota.recordResponse({ rateLimit: { limit: 20, remaining: 0, resetInSeconds: 3600 }, consumedQuota: true });
			await queue.submit(`${DEFAULT_VIN}.charging.enabled`, true);

			expect(results()).to.deep.equal(['EXPIRED']);
			expect(queue.pending).to.equal(0);
		});

		it('verwirft sofort, wenn Retry-After laenger als die Rest-Lebensdauer ist', async () => {
			// rate-limit-exceeded meldet 900 Sekunden - mehr als die zehn Minuten TTL.
			mock.scenario = 'rate-limit-exceeded';
			await queue.submit(`${DEFAULT_VIN}.charging.enabled`, true);

			expect(results()).to.deep.equal(['EXPIRED']);
			expect(last().problemType).to.contain('rate-limit-exceeded');
		});
	});

	describe('Ablehnungen des Fahrzeugs', () => {
		it('merkt sich eine dauerhaft fehlende Faehigkeit', async () => {
			// Das Fixture ist ein BEV: Standheizung gibt es nicht. Der S-PIN steht,
			// damit der Befehl ueberhaupt bis zur API kommt.
			queue = buildQueue({ spin: '1234' });
			await queue.submit(`${DEFAULT_VIN}.auxiliaryHeating.enabled`, true);
			expect(results()).to.deep.equal(['REJECTED_BY_VEHICLE']);

			await queue.submit(`${DEFAULT_VIN}.auxiliaryHeating.enabled`, true);
			// Der zweite Versuch kostet keinen Request mehr.
			expect(mock.requests.filter(r => r.method === 'POST')).to.have.length(1);
			expect(results()).to.deep.equal(['REJECTED_BY_VEHICLE', 'REJECTED_BY_VEHICLE']);
		});

		it('gibt bei einer abgeschalteten Faehigkeit auf, ohne sie zu merken', async () => {
			mock.scenario = 'operation-disabled';
			await queue.submit(`${DEFAULT_VIN}.charging.enabled`, true);
			expect(results()).to.deep.equal(['REJECTED_BY_VEHICLE']);

			mock.scenario = 'ok';
			await queue.submit(`${DEFAULT_VIN}.charging.enabled`, true);
			expect(results()).to.deep.equal(['REJECTED_BY_VEHICLE', 'SENT']);
		});

		it('versucht es erneut, wenn das Fahrzeug gerade nichts annimmt', async () => {
			mock.scenario = 'vehicle-not-accepting-requests';
			await queue.submit(`${DEFAULT_VIN}.charging.enabled`, true);
			expect(results()).to.deep.equal(['QUEUED']);
			expect(queue.pending).to.equal(1);

			// Retry-After sind 120 Sekunden; nach drei Versuchen ist Schluss (E15).
			for (let i = 0; i < 3; i++) {
				clock += 121_000;
				await queue.tick();
			}
			expect(results()).to.deep.equal(['QUEUED', 'REJECTED_BY_VEHICLE']);
			expect(mock.requests.filter(r => r.method === 'POST')).to.have.length(4);
		});
	});

	describe('Fehler, die nicht vom Fahrzeug kommen', () => {
		for (const remaining of [7, 8]) {
			it(`schuetzt die Reserve beim 503-Retry mit ${remaining} freien Requests`, async () => {
				let calls = 0;
				quota.recordResponse({
					consumedQuota: false,
					rateLimit: { limit: 20, remaining, resetInSeconds: 3600 },
				});
				queue = buildQueue({
					client: {
						sendCommand: () => {
							calls++;
							return Promise.resolve({
								ok: false as const,
								error: httpApiError({ status: 503 }),
								meta: { consumedQuota: true },
							});
						},
					},
				});
				await queue.submit(`${DEFAULT_VIN}.charging.start`, true);
				clock += 15_000;
				await queue.tick();
				expect(calls).to.equal(remaining === 7 ? 1 : 2);
				expect(quota.snapshot().remaining).to.equal(6);
			});
		}

		it('erlaubt einen kostenlosen 429-Retry auch innerhalb der Reserve', async () => {
			let calls = 0;
			quota.recordResponse({
				consumedQuota: false,
				rateLimit: { limit: 20, remaining: 3, resetInSeconds: 3600 },
			});
			queue = buildQueue({
				client: {
					sendCommand: () => {
						calls++;
						return Promise.resolve(
							calls === 1
								? {
										ok: false,
										error: httpApiError({
											status: 429,
											body: JSON.stringify({ type: 'vehicle-not-accepting-requests' }),
										}),
										meta: { consumedQuota: false },
									}
								: { ok: true as const, data: undefined, meta: { consumedQuota: true } },
						);
					},
				},
			});
			await queue.submit(`${DEFAULT_VIN}.charging.start`, true);
			clock += 15_000;
			await queue.tick();
			expect(calls).to.equal(2);
			expect(results()).to.deep.equal(['QUEUED', 'SENT']);
		});
		it('meldet einen abgelaufenen Schluessel als FAILED und die Verbindung als gestoert', async () => {
			mock.scenario = 'api-key-expired';
			const verbindung: boolean[] = [];
			queue = buildQueue({ onConnectionChange: value => verbindung.push(value) });

			await queue.submit(`${DEFAULT_VIN}.charging.enabled`, true);
			expect(results()).to.deep.equal(['FAILED']);
			expect(verbindung).to.deep.equal([false]);
		});

		it('meldet einen fehlenden S-PIN, ohne einen Request zu verbrennen', async () => {
			await queue.submit(`${DEFAULT_VIN}.auxiliaryHeating.start`, true);
			expect(results()).to.deep.equal(['FAILED']);
			expect(mock.requests).to.have.length(0);
			expect(log.lines.some(line => line.includes('S-PIN'))).to.equal(true);
		});

		it('arbeitet nach einem Fehler beim Schreiben des Reports weiter', async () => {
			let reportCalls = 0;
			queue = buildQueue({
				onReport: () => {
					reportCalls += 1;
					if (reportCalls === 1) {
						return Promise.reject(new Error('State-DB voruebergehend nicht erreichbar'));
					}
				},
			});

			await queue.submit(`${DEFAULT_VIN}.charging.start`, true);
			await queue.submit(`${DEFAULT_VIN}.charging.stop`, true);

			expect(mock.requests.filter(request => request.method === 'POST')).to.have.length(2);
			expect(verified).to.deep.equal([DEFAULT_VIN, DEFAULT_VIN]);
			expect(log.lines.some(line => line.includes('Ergebnis konnte nicht'))).to.equal(true);
		});
	});

	describe('Koerper des Requests', () => {
		it('baut die Klimatisierung aus der letzten Antwort', async () => {
			const sent: Array<[CommandDomain, CommandAction, CommandBody | undefined]> = [];
			const stub: CommandSender = {
				sendCommand: (
					_vin: string,
					domain: CommandDomain,
					action: CommandAction,
					body?: CommandBody,
				): Promise<ApiResult<void>> => {
					sent.push([domain, action, body]);
					return Promise.resolve({
						ok: true,
						data: undefined,
						meta: { consumedQuota: true },
					});
				},
			};
			queue = buildQueue({ client: stub, spin: '1234' });

			const poll = await client.getVehicle(DEFAULT_VIN);
			if (poll.ok) {
				queue.updateFromResponse(DEFAULT_VIN, poll.data);
			}
			await queue.submit(`${DEFAULT_VIN}.airConditioning.enabled`, true);

			expect(sent).to.have.length(1);
			expect(sent[0][0]).to.equal('air-conditioning');
			// 23 Grad stehen im Fixture - der Adapter erfindet nichts.
			expect(sent[0][2]).to.deep.equal({ targetTemperature: { value: 23, unit: 'CELSIUS' } });
		});
	});
});
