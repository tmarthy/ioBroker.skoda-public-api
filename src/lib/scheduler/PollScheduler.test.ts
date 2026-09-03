import { expect } from 'chai';
import { FakeAdapter } from '../../../test/helpers/fakeAdapter';
import { DEFAULT_API_KEY, DEFAULT_VIN, MockSkodaApi } from '../../../test/mock/server';
import { SkodaApiClient, type ApiResult } from '../api/client';
import type { VehiclePart, VehicleResponse } from '../api/types';
import { QuotaManager } from '../quota/QuotaManager';
import { StateWriter } from '../states/StateWriter';
import { MIN_IDLE_MS, PollScheduler, type SchedulerLog, type VehicleReader } from './PollScheduler';

const MINUTE = 60_000;

/** Ein Log, das nichts ausgibt, aber alles behaelt. */
class RecordingLog implements SchedulerLog {
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

describe('scheduler/PollScheduler => Kadenz unter 20 Requests pro Stunde', () => {
	let clock: number;
	let mock: MockSkodaApi;
	let client: SkodaApiClient;
	let quota: QuotaManager;
	let log: RecordingLog;
	let adapter: FakeAdapter;
	let writer: StateWriter;
	let connection: boolean[];

	const now = (): number => clock;

	/**
	 * Baut einen Scheduler mit dem Mock als Gegenstelle.
	 *
	 * @param options Abweichungen von der Vorgabe.
	 * @returns Der Scheduler.
	 */
	const buildScheduler = (options: Partial<ConstructorParameters<typeof PollScheduler>[0]> = {}): PollScheduler =>
		new PollScheduler({
			client,
			quota,
			vins: [DEFAULT_VIN],
			onVehicleData: (vin, response) => writer.write(vin, response),
			log,
			onConnectionChange: value => connection.push(value),
			now,
			// Fester Jitter, damit Wartezeiten in Tests nachrechenbar bleiben.
			random: () => 0.5,
			...options,
		});

	beforeEach(async () => {
		clock = Date.parse('2026-09-03T18:00:00Z');
		mock = new MockSkodaApi({ now });
		const baseUrl = await mock.start();
		client = new SkodaApiClient({ apiKey: DEFAULT_API_KEY, baseUrl, timeoutMs: 2000 });
		quota = new QuotaManager({ now });
		log = new RecordingLog();
		adapter = new FakeAdapter();
		writer = new StateWriter({ api: adapter, now });
		connection = [];
	});

	afterEach(async () => {
		await mock.stop();
	});

	describe('Kadenz', () => {
		it('fragt sofort und danach im Grundintervall', async () => {
			const scheduler = buildScheduler();
			const wait = await scheduler.tick();

			expect(mock.requests).to.have.length(1);
			expect(wait).to.equal(15 * MINUTE);
		});

		it('haelt die Untergrenze ein, auch wenn die Konfiguration schneller will', async () => {
			const scheduler = buildScheduler({ intervals: { idleMs: 30_000 } });
			expect(await scheduler.tick()).to.equal(MIN_IDLE_MS);
		});

		it('schaltet beim ladenden Fahrzeug auf die aktive Kadenz', async () => {
			mock.loadFixture('charging');
			const scheduler = buildScheduler();
			expect(await scheduler.tick()).to.equal(5 * MINUTE);
			expect(scheduler.snapshot()[0].active).to.equal(true);
		});

		it('zaehlt eine laufende Klimatisierung als aktiv', async () => {
			mock.loadFixture('climatising');
			const scheduler = buildScheduler();
			expect(await scheduler.tick()).to.equal(5 * MINUTE);
		});
	});

	describe('Frische-Backoff', () => {
		it('verdoppelt das Intervall, solange der Zeitstempel steht', async () => {
			const scheduler = buildScheduler();
			const waits: number[] = [];
			for (let i = 0; i < 5; i++) {
				const wait = await scheduler.tick();
				waits.push(wait);
				clock += wait;
			}
			// Der erste Poll kennt den Zeitstempel noch nicht, danach verdoppelt sich
			// das Intervall bis zum Deckel von 60 Minuten.
			expect(waits.map(w => w / MINUTE)).to.deep.equal([15, 30, 60, 60, 60]);
		});

		it('faellt sofort auf die Grundkadenz zurueck, wenn das Auto sich meldet', async () => {
			const scheduler = buildScheduler();
			await scheduler.tick();
			clock += 15 * MINUTE;
			expect(await scheduler.tick()).to.equal(30 * MINUTE);

			clock += 30 * MINUTE;
			mock.vehicleState.status.carCapturedTimestamp = new Date(clock).toISOString();
			expect(await scheduler.tick()).to.equal(15 * MINUTE);
		});

		it('vergleicht Zeitstempel nach Millisekunden, nicht als Zeichenkette', async () => {
			const scheduler = buildScheduler();
			await scheduler.tick();
			clock += 15 * MINUTE;

			// Dieselbe Zeit, andere Schreibweise: 9 Nachkommastellen statt 3. Ein
			// Zeichenkettenvergleich saehe hier eine Aenderung, wo keine ist.
			const stamp = String(mock.vehicleState.status.carCapturedTimestamp);
			mock.vehicleState.status.carCapturedTimestamp = stamp.replace(/(\.\d+)?Z$/, '.000000000Z');
			expect(await scheduler.tick()).to.equal(30 * MINUTE);
		});
	});

	describe('Faehigkeitserkennung und include', () => {
		it('fragt den ersten Poll ohne include und danach mit der gelernten Liste', async () => {
			const scheduler = buildScheduler();
			await scheduler.tick();
			expect(mock.requests[0].path).to.not.contain('include');

			clock += 15 * MINUTE;
			await scheduler.tick();
			const second = decodeURIComponent(mock.requests[1].path);
			expect(second).to.contain('include=');
			expect(second).to.contain('charging');
			expect(second).to.contain('parkingPosition');
			// Was das Fahrzeug nicht liefert, steht auch nicht in der Liste.
			expect(second).to.not.contain('fuelStatus');
			expect(second).to.not.contain('auxiliaryHeating');
		});

		it('fordert die Parkposition gar nicht erst an, wenn sie abgeschaltet ist', async () => {
			const scheduler = buildScheduler({ readParkingPosition: false });
			await scheduler.tick();
			clock += 15 * MINUTE;
			await scheduler.tick();

			for (const request of mock.requests) {
				expect(decodeURIComponent(request.path)).to.not.contain('parkingPosition');
			}
			// Ohne Parkposition geht schon der erste Poll mit include hinaus - sonst
			// laege sie in der Antwort, bevor irgendjemand sie abwaehlen konnte.
			expect(mock.requests[0].path).to.contain('include=');
			expect(adapter.objects.has(`${DEFAULT_VIN}.parkingPosition.position`)).to.equal(false);
		});

		it('streicht dauerhaft nicht unterstuetzte Teile aus der Liste', async () => {
			// Mit include meldet der Mock nicht unterstuetzte Teile als
			// *_UNSUPPORTED - danach wird nicht mehr danach gefragt.
			const scheduler = buildScheduler({ readParkingPosition: false });
			await scheduler.tick();
			expect(decodeURIComponent(mock.requests[0].path)).to.contain('fuelStatus');

			clock += 15 * MINUTE;
			await scheduler.tick();
			expect(decodeURIComponent(mock.requests[1].path)).to.not.contain('fuelStatus');
		});

		it('haelt einen nur voruebergehend gestoerten Teil in der Liste', async () => {
			const scheduler = buildScheduler();
			clock += await scheduler.tick();

			mock.scenario = 'partial-data';
			clock += await scheduler.tick();

			mock.scenario = 'ok';
			await scheduler.tick();
			// CHARGING_UNAVAILABLE heisst "gerade nicht abrufbar", nicht "kann es nicht".
			expect(decodeURIComponent(mock.requests[2].path)).to.contain('charging');
		});
	});

	describe('Das Budget entscheidet', () => {
		it('fragt gar nicht erst, wenn der QuotaManager ablehnt', async () => {
			quota.recordResponse({ rateLimit: { limit: 20, remaining: 3, resetInSeconds: 1800 }, consumedQuota: true });
			const scheduler = buildScheduler();

			const wait = await scheduler.tick();
			expect(mock.requests).to.have.length(0);
			expect(wait).to.equal(1800 * 1000);
			expect(log.lines.some(line => line.includes('reserve'))).to.equal(true);
		});

		it('nimmt den Faden wieder auf, sobald das Fenster sich oeffnet', async () => {
			quota.recordResponse({ rateLimit: { limit: 20, remaining: 3, resetInSeconds: 60 }, consumedQuota: true });
			const scheduler = buildScheduler();
			await scheduler.tick();

			clock += 61_000;
			await scheduler.tick();
			expect(mock.requests).to.have.length(1);
		});
	});

	describe('Fehler', () => {
		it('setzt eine unbekannte VIN dauerhaft aus', async () => {
			mock.scenario = 'not-found';
			const scheduler = buildScheduler();
			await scheduler.tick();
			expect(scheduler.snapshot()[0].suspended).to.equal(true);

			clock += 60 * MINUTE;
			await scheduler.tick();
			expect(mock.requests).to.have.length(1);
		});

		it('drosselt bei abgelaufenem Schluessel auf einmal pro Stunde', async () => {
			mock.scenario = 'api-key-expired';
			const scheduler = buildScheduler();
			expect(await scheduler.tick()).to.equal(60 * MINUTE);
			expect(connection).to.deep.equal([false]);
		});

		it('meldet die Verbindung erst als gestoert und dann wieder als gut', async () => {
			mock.scenario = 'api-key-not-authorized';
			const scheduler = buildScheduler();
			await scheduler.tick();

			clock += 60 * MINUTE;
			mock.scenario = 'ok';
			await scheduler.tick();
			expect(connection).to.deep.equal([false, true]);
		});

		it('wartet bei erschoepftem Budget die Zeit aus Retry-After ab', async () => {
			mock.scenario = 'rate-limit-exceeded';
			const scheduler = buildScheduler();
			expect(await scheduler.tick()).to.equal(900_000);
			// Ein leeres Budget ist Normalbetrieb, kein Verbindungsfehler (E10).
			expect(connection).to.deep.equal([]);
		});

		it('wiederholt einen Serverfehler genau einmal', async () => {
			mock.scenario = 'server-error';
			const scheduler = buildScheduler();

			const first = await scheduler.tick();
			expect(first).to.equal(15_000);
			clock += first;

			// Zweiter Versuch scheitert ebenfalls: danach zurueck in die Kadenz,
			// statt weiter Budget zu verbrennen (E15).
			const second = await scheduler.tick();
			expect(second).to.equal(15 * MINUTE);
			expect(mock.requests).to.have.length(2);
		});
	});

	describe('Verifikations-Poll nach einem Befehl', () => {
		it('zieht den naechsten Poll auf 60 Sekunden vor', async () => {
			const scheduler = buildScheduler();
			await scheduler.tick();

			scheduler.requestVerificationPoll(DEFAULT_VIN);
			expect(scheduler.snapshot()[0].nextDueAt).to.equal(clock + 60_000);

			clock += 60_000;
			await scheduler.tick();
			expect(mock.requests).to.have.length(2);
		});

		it('bleibt danach zehn Minuten auf der aktiven Kadenz', async () => {
			const scheduler = buildScheduler();
			await scheduler.tick();
			scheduler.requestVerificationPoll(DEFAULT_VIN);

			clock += 60_000;
			expect(await scheduler.tick()).to.equal(5 * MINUTE);

			// Nach Ablauf des Befehlsfensters wieder die Grundkadenz - der Backoff
			// beginnt dabei von vorn, weil ein Befehl den Zustand geaendert hat.
			clock += 11 * MINUTE;
			expect(await scheduler.tick()).to.equal(30 * MINUTE);
		});
	});

	describe('Mehrere Fahrzeuge', () => {
		it('fragt sie reihum aus demselben Budget', async () => {
			const asked: string[] = [];
			const stub: VehicleReader = {
				getVehicle: (vin: string): Promise<ApiResult<VehicleResponse>> => {
					asked.push(vin);
					return Promise.resolve({
						ok: true,
						data: { vehicle: { vin } },
						meta: { rateLimit: { limit: 20, remaining: 19, resetInSeconds: 3600 }, consumedQuota: true },
					});
				},
			};
			const scheduler = new PollScheduler({
				client: stub,
				quota,
				vins: ['TMBJB9NY5RF999999', 'TMBJC1NY0SF123456'],
				onVehicleData: () => undefined,
				log,
				now,
			});

			await scheduler.tick();
			expect(asked).to.deep.equal(['TMBJB9NY5RF999999', 'TMBJC1NY0SF123456']);

			clock += 15 * MINUTE;
			await scheduler.tick();
			expect(asked).to.have.length(4);
		});
	});

	describe('Schleife', () => {
		it('haengt am Zeitgeber des Adapters und laesst ihn beim Stoppen los', () => {
			const timers: Array<{ handler: () => void; ms: number }> = [];
			const cleared: number[] = [];
			const scheduler = buildScheduler({
				setTimer: (handler, ms) => {
					timers.push({ handler, ms });
					return timers.length - 1;
				},
				clearTimer: handle => {
					cleared.push(handle as number);
				},
			});

			scheduler.start();
			expect(timers).to.have.length(1);
			expect(timers[0].ms).to.equal(0);

			scheduler.stop();
			expect(cleared).to.deep.equal([0]);
		});
	});

	describe('Abnahme: eine simulierte Stunde', () => {
		/**
		 * Faehrt den Scheduler ueber eine Zeitspanne, wie die Schleife es taete.
		 *
		 * @param scheduler Der Scheduler.
		 * @param durationMs Wie lange simuliert wird.
		 */
		const runFor = async (scheduler: PollScheduler, durationMs: number): Promise<void> => {
			const end = clock + durationMs;
			while (clock < end) {
				clock += await scheduler.tick();
			}
		};

		it('bleibt beim schlafenden Auto weit unter 20 Requests und drosselt sich', async () => {
			const scheduler = buildScheduler({ intervals: { idleMs: MIN_IDLE_MS } });
			await runFor(scheduler, 60 * MINUTE);

			expect(mock.requests.length).to.be.lessThan(20);
			expect(mock.requests.every(r => r.status === 200)).to.equal(true);
			// Fuenf Minuten Grundkadenz waeren zwoelf Polls gewesen.
			expect(mock.requests.length).to.be.lessThan(12);
			// Aus fuenf Minuten sind messbar laengere Abstaende geworden.
			expect(scheduler.snapshot()[0].intervalMs).to.be.greaterThanOrEqual(4 * MIN_IDLE_MS);

			// Und der Objektbaum steht.
			expect(adapter.val(`${DEFAULT_VIN}.charging.status.battery.stateOfChargeInPercent`)).to.equal(73);
			expect(adapter.val(`${DEFAULT_VIN}.odometer.mileageInKm`)).to.equal(30069);
		});

		it('bleibt beim wachen Auto in der Kadenz und trotzdem im Budget', async () => {
			const scheduler = buildScheduler({ intervals: { idleMs: MIN_IDLE_MS } });
			const end = clock + 60 * MINUTE;
			while (clock < end) {
				clock += await scheduler.tick();
				// Das Auto meldet sich bei jedem Poll mit frischen Daten.
				mock.vehicleState.status.carCapturedTimestamp = new Date(clock).toISOString();
			}

			expect(mock.requests.length).to.be.greaterThan(8);
			expect(mock.requests.length).to.be.lessThanOrEqual(20);
			expect(mock.requests.every(r => r.status === 200)).to.equal(true);
			// Die Reserve fuer Befehle bleibt trotzdem stehen.
			expect(quota.snapshot().remaining).to.be.greaterThanOrEqual(6);
		});

		it('laeuft beim schlafenden Auto in den Deckel von 60 Minuten', async () => {
			const scheduler = buildScheduler({ intervals: { idleMs: MIN_IDLE_MS } });
			await runFor(scheduler, 3 * 60 * MINUTE);
			expect(scheduler.snapshot()[0].intervalMs).to.equal(60 * MINUTE);
			expect(mock.requests.length).to.be.lessThan(10);
		});

		it('laesst nach einer Stunde Budget fuer Befehle uebrig', async () => {
			const scheduler = buildScheduler({ intervals: { idleMs: MIN_IDLE_MS } });
			await runFor(scheduler, 60 * MINUTE);
			expect(quota.tryAcquire('command')).to.equal('ok');
		});
	});

	it('nennt die VIN im Log nur gekuerzt', async () => {
		mock.scenario = 'not-found';
		const scheduler = buildScheduler();
		await scheduler.tick();
		expect(log.lines.join('\n')).to.not.contain(DEFAULT_VIN);
	});

	it('reicht die Antwort unveraendert nach oben, statt selbst zu schreiben', async () => {
		const seen: Array<[string, VehicleResponse]> = [];
		const scheduler = buildScheduler({
			onVehicleData: (vin, response) => {
				seen.push([vin, response]);
			},
		});
		await scheduler.tick();

		expect(seen).to.have.length(1);
		expect(seen[0][0]).to.equal(DEFAULT_VIN);
		expect(seen[0][1].vehicle.vin).to.equal(DEFAULT_VIN);
		// Der Scheduler kennt den StateWriter nicht - hier wurde nichts geschrieben.
		expect(adapter.objects.size).to.equal(0);
	});
});

// Die Typen aus der Signatur, damit der Test nicht an einer Umbenennung vorbeilaeuft.
export type { VehiclePart };
