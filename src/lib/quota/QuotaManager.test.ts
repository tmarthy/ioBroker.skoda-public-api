import { expect } from 'chai';
import { DEFAULT_API_KEY, DEFAULT_VIN, MockSkodaApi } from '../../../test/mock/server';
import { SkodaApiClient, type ApiMeta } from '../api/client';
import {
	DEFAULT_COMMAND_RESERVE,
	DEFAULT_WINDOW_MS,
	QuotaManager,
	type PersistedQuota,
	type QuotaStore,
	type RequestPermit,
} from './QuotaManager';

/** Ablage im Speicher - der Neustart besteht darin, einen zweiten Manager daranzuhaengen. */
class MemoryStore implements QuotaStore {
	public state?: PersistedQuota;
	public failing = false;

	public load(): Promise<PersistedQuota | undefined> {
		return this.failing ? Promise.reject(new Error('Ablage nicht lesbar')) : Promise.resolve(this.state);
	}

	public save(state: PersistedQuota): Promise<void> {
		if (this.failing) {
			return Promise.reject(new Error('Ablage nicht schreibbar'));
		}
		this.state = { ...state };
		return Promise.resolve();
	}
}

/** Kontrollierbar langsame Ablage fuer die Reihenfolge paralleler Persistenzanfragen. */
class DelayedStore implements QuotaStore {
	public state?: PersistedQuota;
	public active = 0;
	public maxActive = 0;
	private readonly saves: Array<{ state: PersistedQuota; resolve: () => void }> = [];

	public load(): Promise<PersistedQuota | undefined> {
		return Promise.resolve(this.state);
	}

	public save(state: PersistedQuota): Promise<void> {
		this.active += 1;
		this.maxActive = Math.max(this.maxActive, this.active);
		return new Promise(resolve => this.saves.push({ state: { ...state }, resolve }));
	}

	public releaseNext(): void {
		const save = this.saves.shift();
		if (!save) {
			throw new Error('Kein Save wartet');
		}
		this.state = save.state;
		this.active -= 1;
		save.resolve();
	}

	public get waiting(): number {
		return this.saves.length;
	}
}

describe('quota/QuotaManager => ein Bucket einer VIN', () => {
	let clock: number;

	const now = (): number => clock;

	// Eine Antwort mit Quota-Headern, wie sie der Client liefert.
	const withHeaders = (remaining: number, options: Partial<ApiMeta> & { resetInSeconds?: number } = {}): ApiMeta => ({
		rateLimit: { limit: 20, remaining, resetInSeconds: options.resetInSeconds ?? 3600 },
		consumedQuota: options.consumedQuota ?? true,
	});

	// Eine Antwort ohne Header - der Netzwerkfehler.
	const withoutHeaders = (consumedQuota: boolean): ApiMeta => ({ consumedQuota });

	const acquire = (manager: QuotaManager, priority: 'poll' | 'command' = 'poll'): RequestPermit => {
		const result = manager.tryAcquire(priority);
		expect(result).to.not.have.property('reason');
		if ('reason' in result) {
			throw new Error(`Request unerwartet abgelehnt: ${result.reason}`);
		}
		return result;
	};

	// Ein Request von Anfang bis Ende, wie ihn der PollScheduler absetzt.
	const roundTrip = (manager: QuotaManager, meta: ApiMeta, priority: 'poll' | 'command' = 'poll'): void => {
		manager.recordResponse(meta, acquire(manager, priority));
	};

	beforeEach(() => {
		clock = Date.parse('2026-09-03T18:00:00Z');
	});

	describe('Reserve fuer Befehle', () => {
		it('laesst einen Poll durch, solange mehr als die Reserve uebrig ist', () => {
			const manager = new QuotaManager({ now });
			manager.recordResponse(withHeaders(DEFAULT_COMMAND_RESERVE + 1));
			acquire(manager);
		});

		it('lehnt den Poll ab, sobald nur noch die Reserve steht', () => {
			const manager = new QuotaManager({ now });
			manager.recordResponse(withHeaders(DEFAULT_COMMAND_RESERVE));

			const denied = manager.tryAcquire('poll');
			expect(denied).to.have.property('reason');
			if (!('reason' in denied)) {
				throw new Error('Poll unerwartet zugelassen');
			}
			expect(denied.reason).to.equal('reserve');
			expect(denied.waitMs).to.equal(manager.snapshot().resetAt - clock);
		});

		it('laesst den Befehl genau dort weitermachen, wo der Poll aufhoert', () => {
			const manager = new QuotaManager({ now });
			manager.recordResponse(withHeaders(DEFAULT_COMMAND_RESERVE));
			expect(manager.tryAcquire('poll')).to.have.property('reason');
			acquire(manager, 'command');
		});

		it('laesst Befehle bis zur letzten Anfrage zu und haelt dann an', () => {
			const manager = new QuotaManager({ now });
			manager.recordResponse(withHeaders(1));
			roundTrip(manager, withHeaders(0), 'command');

			const denied = manager.tryAcquire('command');
			expect(denied).to.have.property('reason');
			if (!('reason' in denied)) {
				throw new Error('Befehl unerwartet zugelassen');
			}
			expect(denied.reason).to.equal('exhausted');
		});

		it('meldet im Snapshot, wie viel ein Poll noch hat', () => {
			const manager = new QuotaManager({ now });
			manager.recordResponse(withHeaders(9));
			expect(manager.snapshot().reserveFree).to.equal(9 - DEFAULT_COMMAND_RESERVE);
		});
	});

	describe('Die Header sind die Wahrheit', () => {
		it('uebernimmt den Reststand aus jeder Antwort', () => {
			const manager = new QuotaManager({ now });
			manager.recordResponse(withHeaders(3));
			expect(manager.snapshot().remaining).to.equal(3);
			// Auch nach oben: Vielleicht laeuft eine zweite Instanz auf demselben
			// Schluessel, vielleicht hat Skoda das Limit geaendert. Beides ist nicht
			// unsere Rechnung.
			manager.recordResponse(withHeaders(15));
			expect(manager.snapshot().remaining).to.equal(15);
		});

		it('unterscheidet Schaetzung und Bestaetigung', () => {
			const manager = new QuotaManager({ now });
			expect(manager.snapshot().confirmed).to.equal(false);
			expect(manager.snapshot().remaining).to.equal(20);
			manager.recordResponse(withHeaders(19));
			expect(manager.snapshot().confirmed).to.equal(true);
		});

		it('laesst 429 den Reststand unberuehrt', () => {
			const manager = new QuotaManager({ now });
			manager.recordResponse(withHeaders(12));
			roundTrip(manager, withHeaders(12, { consumedQuota: false }));
			expect(manager.snapshot().remaining).to.equal(12);
		});

		it('laesst 401 und 403 den Reststand unberuehrt', () => {
			const manager = new QuotaManager({ now });
			manager.recordResponse(withHeaders(12));
			roundTrip(manager, withHeaders(12, { consumedQuota: false }));
			roundTrip(manager, withHeaders(12, { consumedQuota: false }));
			expect(manager.snapshot().remaining).to.equal(12);
		});

		it('laesst 503 den Reststand sinken - der teure Fall', () => {
			const manager = new QuotaManager({ now });
			manager.recordResponse(withHeaders(12));
			roundTrip(manager, withHeaders(11));
			expect(manager.snapshot().remaining).to.equal(11);
		});

		it('uebernimmt den Zeitpunkt des Zuruecksetzens aus RateLimit-Reset', () => {
			const manager = new QuotaManager({ now });
			manager.recordResponse(withHeaders(5, { resetInSeconds: 900 }));
			expect(manager.snapshot().resetAt).to.equal(clock + 900_000);
		});

		it('zaehlt einen Netzwerkfehler ohne Header konservativ herunter', () => {
			const manager = new QuotaManager({ now });
			roundTrip(manager, withoutHeaders(true));
			expect(manager.snapshot().remaining).to.equal(19);
			// Geschaetzt, nicht bestaetigt: Die naechste echte Antwort korrigiert das.
			expect(manager.snapshot().confirmed).to.equal(false);
		});
	});

	describe('Laufende Requests', () => {
		it('rechnet abgesetzte, aber unbeantwortete Requests ab', () => {
			const manager = new QuotaManager({ now });
			manager.recordResponse(withHeaders(8));
			acquire(manager);
			acquire(manager);

			const snapshot = manager.snapshot();
			expect(snapshot.inFlight).to.equal(2);
			expect(snapshot.reserveFree).to.equal(0);
			// Zwei unterwegs, also stehen nur noch sechs zur Verfuegung - genau die
			// Reserve. Ein dritter Poll waere einer zu viel.
			expect(manager.tryAcquire('poll')).to.have.property('reason');
		});

		it('zieht laufende Requests auch vom bestaetigten Stand ab', () => {
			const manager = new QuotaManager({ now });
			acquire(manager);
			const second = acquire(manager);
			manager.recordResponse(withHeaders(19), second);

			const snapshot = manager.snapshot();
			expect(snapshot.remaining).to.equal(19);
			expect(snapshot.inFlight).to.equal(1);
			expect(snapshot.reserveFree).to.equal(19 - 1 - DEFAULT_COMMAND_RESERVE);
		});

		it('laesst eine spaete alte Antwort keinen neueren Headerstand ueberschreiben', () => {
			const manager = new QuotaManager({ now });
			const first = acquire(manager);
			const second = acquire(manager);

			// Der spaeter gestartete Request kommt zuerst zurueck. Seine niedrigere
			// Restquota und sein Reset-Zeitpunkt sind der neuere Stand.
			manager.recordResponse(withHeaders(18, { resetInSeconds: 1800 }), second);
			manager.recordResponse(withHeaders(19, { resetInSeconds: 3600 }), first);

			const snapshot = manager.snapshot();
			expect(snapshot.remaining).to.equal(18);
			expect(snapshot.resetAt).to.equal(clock + 1800 * 1000);
			expect(snapshot.inFlight).to.equal(0);
		});

		it('uebernimmt aus einer spaeten Antwort weiterhin einen niedrigeren Reststand', () => {
			const manager = new QuotaManager({ now });
			const first = acquire(manager);
			const second = acquire(manager);

			manager.recordResponse(withHeaders(18), second);
			manager.recordResponse(withHeaders(17), first);

			expect(manager.snapshot().remaining).to.equal(17);
		});

		it('uebernimmt keinen spaeten Reststand aus einem alten Fenster', () => {
			const manager = new QuotaManager({ now });
			const oldWindow = acquire(manager);
			clock += DEFAULT_WINDOW_MS + 1;
			const newWindow = acquire(manager);

			manager.recordResponse(withHeaders(19), newWindow);
			manager.recordResponse(withHeaders(0, { resetInSeconds: 1 }), oldWindow);

			expect(manager.snapshot().remaining).to.equal(19);
		});

		it('ignoriert eine doppelt gemeldete Antwort derselben Buchung', () => {
			const manager = new QuotaManager({ now });
			const permit = acquire(manager);
			manager.recordResponse(withHeaders(19), permit);
			manager.recordResponse(withHeaders(3), permit);

			expect(manager.snapshot().remaining).to.equal(19);
			expect(manager.snapshot().inFlight).to.equal(0);
		});

		it('speichert Quota-Staende streng nacheinander', async () => {
			const store = new DelayedStore();
			const manager = new QuotaManager({ now, store });
			const first = acquire(manager);
			const second = acquire(manager);
			manager.recordResponse(withHeaders(18), second);
			manager.recordResponse(withHeaders(19), first);

			// Trotz vier Persistenzanlaessen laeuft nur der erste Save. Die
			// Zwischenstaende werden zum neuesten Stand zusammengefasst.
			expect(store.waiting).to.equal(1);
			expect(store.maxActive).to.equal(1);
			store.releaseNext();
			await Promise.resolve();
			expect(store.waiting).to.equal(1);
			expect(store.maxActive).to.equal(1);

			store.releaseNext();
			await manager.flush();
			expect(store.state?.remaining).to.equal(18);
		});
	});

	describe('Fenster', () => {
		it('fuellt das Budget auf, wenn das Fenster abgelaufen ist', () => {
			const manager = new QuotaManager({ now });
			manager.recordResponse(withHeaders(0));
			expect(manager.tryAcquire('command')).to.have.property('reason');

			clock += 3_600_001;
			expect(manager.snapshot().remaining).to.equal(20);
			expect(manager.snapshot().confirmed).to.equal(false);
			acquire(manager);
		});
	});

	describe('Neustart', () => {
		it('holt den Zustand aus der Ablage zurueck', async () => {
			const store = new MemoryStore();
			const first = new QuotaManager({ now, store });
			roundTrip(first, withHeaders(8, { resetInSeconds: 1800 }));
			await first.flush();

			clock += DEFAULT_WINDOW_MS / 20;
			const second = new QuotaManager({ now, store });
			await second.start();

			const snapshot = second.snapshot();
			expect(snapshot.remaining).to.equal(8);
			expect(snapshot.resetAt).to.equal(first.snapshot().resetAt);
		});

		it('sperrt den ersten Request nach dem Neustart', async () => {
			const store = new MemoryStore();
			const first = new QuotaManager({ now, store });
			roundTrip(first, withHeaders(19));

			clock += 2_000;
			const second = new QuotaManager({ now, store });
			await second.start();

			const denied = second.tryAcquire('poll');
			expect(denied).to.have.property('reason');
			if (!('reason' in denied)) {
				throw new Error('Poll unerwartet zugelassen');
			}
			expect(denied.reason).to.equal('startup-guard');
			expect(denied.waitMs).to.equal(DEFAULT_WINDOW_MS / 20 - 2_000);

			clock += denied.waitMs;
			acquire(second);
		});

		it('sperrt auch Befehle - die Schleife kostet unabhaengig vom Anlass', async () => {
			const store = new MemoryStore();
			roundTrip(new QuotaManager({ now, store }), withHeaders(19));

			const second = new QuotaManager({ now, store });
			await second.start();
			expect(second.tryAcquire('command')).to.have.property('reason');
		});

		it('verbrennt in einer Neustartschleife nicht das ganze Budget', async () => {
			// Der Fall aus dem Plan: Ohne Sperrfrist sind 20 Requests in 90 Sekunden
			// weg. Hier startet der Adapter alle drei Sekunden neu und stuerzt nach
			// dem Poll ab.
			const store = new MemoryStore();
			let requests = 0;
			for (let i = 0; i < 30; i++) {
				const manager = new QuotaManager({ now, store });
				await manager.start();
				const permit = manager.tryAcquire('poll');
				if (!('reason' in permit)) {
					requests += 1;
					manager.recordResponse(withHeaders(20 - requests), permit);
				}
				clock += 3_000;
			}
			expect(requests).to.equal(1);
		});

		it('zaehlt einen Request, der ohne Antwort endete, als verbraucht', async () => {
			const store = new MemoryStore();
			const first = new QuotaManager({ now, store });
			// Abgesetzt, dann abgestuerzt: keine Antwort, kein recordResponse.
			acquire(first);

			clock += DEFAULT_WINDOW_MS / 20;
			const second = new QuotaManager({ now, store });
			await second.start();
			expect(second.snapshot().remaining).to.equal(19);
		});

		it('startet mit vollem Budget, wenn das Fenster inzwischen abgelaufen ist', async () => {
			const store = new MemoryStore();
			const first = new QuotaManager({ now, store });
			roundTrip(first, withHeaders(2, { resetInSeconds: 60 }));
			await first.flush();

			clock += 120_000;
			const second = new QuotaManager({ now, store });
			await second.start();
			expect(second.snapshot().remaining).to.equal(20);

			// Volles Budget heisst nicht "sofort": Die Sperrfrist nach dem Neustart
			// haengt am letzten Request, nicht am Fenster, und laeuft hier noch.
			const denied = second.tryAcquire('poll');
			expect(denied).to.have.property('reason');
			if (!('reason' in denied)) {
				throw new Error('Poll unerwartet zugelassen');
			}
			expect(denied.reason).to.equal('startup-guard');
			clock += denied.waitMs;
			acquire(second);
		});

		it('kommt ohne Ablage aus', async () => {
			const manager = new QuotaManager({ now });
			await manager.start();
			acquire(manager);
		});

		it('meldet Fehler der Ablage und arbeitet weiter', async () => {
			const store = new MemoryStore();
			store.failing = true;
			const errors: unknown[] = [];
			const manager = new QuotaManager({ now, store, onStoreError: error => errors.push(error) });

			await manager.start();
			acquire(manager);
			// Ein Schreibfehler laeuft asynchron auf - einmal die Schleife durchlassen.
			await Promise.resolve();
			await Promise.resolve();
			expect(errors.length).to.be.greaterThan(0);
		});
	});

	describe('Zusammenspiel mit dem Client', () => {
		let mock: MockSkodaApi;
		let client: SkodaApiClient;

		beforeEach(async () => {
			mock = new MockSkodaApi({ now });
			const baseUrl = await mock.start();
			client = new SkodaApiClient({ apiKey: DEFAULT_API_KEY, baseUrl, timeoutMs: 2000 });
		});

		afterEach(async () => {
			await mock.stop();
		});

		it('haelt den Poll an, bevor die API mit 429 antworten muss', async () => {
			const manager = new QuotaManager({ now });
			let polls = 0;
			while (true) {
				const permit = manager.tryAcquire('poll');
				if ('reason' in permit) {
					break;
				}
				const result = await client.getVehicle(DEFAULT_VIN);
				manager.recordResponse(result.meta, permit);
				polls += 1;
			}

			expect(polls).to.equal(20 - DEFAULT_COMMAND_RESERVE);
			expect(mock.requests.every(r => r.status === 200)).to.equal(true);
			expect(manager.snapshot().remaining).to.equal(DEFAULT_COMMAND_RESERVE);
			expect(mock.quota.remaining).to.equal(DEFAULT_COMMAND_RESERVE);
		});

		it('laesst den Befehl auch dann noch durch, wenn der Poll schon aussetzt', async () => {
			const manager = new QuotaManager({ now });
			while (true) {
				const permit = manager.tryAcquire('poll');
				if ('reason' in permit) {
					break;
				}
				manager.recordResponse((await client.getVehicle(DEFAULT_VIN)).meta, permit);
			}

			const commandPermit = acquire(manager, 'command');
			const result = await client.sendCommand(DEFAULT_VIN, 'charging', 'start');
			manager.recordResponse(result.meta, commandPermit);
			expect(result.ok).to.equal(true);
			expect(manager.snapshot().remaining).to.equal(DEFAULT_COMMAND_RESERVE - 1);
		});

		it('uebernimmt den Reststand der API, auch wenn er unerwartet niedrig ist', async () => {
			// Zweite Instanz am selben Schluessel: Der Mock startet mit einem Budget,
			// das der Manager nicht kennt.
			await mock.stop();
			mock = new MockSkodaApi({ now, rateLimit: 3 });
			const baseUrl = await mock.start();
			client = new SkodaApiClient({ apiKey: DEFAULT_API_KEY, baseUrl, timeoutMs: 2000 });

			const manager = new QuotaManager({ now, commandReserve: 1 });
			const permit = acquire(manager);
			manager.recordResponse((await client.getVehicle(DEFAULT_VIN)).meta, permit);

			expect(manager.snapshot().limit).to.equal(3);
			expect(manager.snapshot().remaining).to.equal(2);
		});
	});
});
