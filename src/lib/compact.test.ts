import { rejects } from 'node:assert/strict';
import { expect } from 'chai';
import { createServer, type Server } from 'node:http';
import { once } from 'node:events';
import { join } from 'node:path';
import { createTranslator } from './i18n';
import { Lifecycle, ShutdownError } from './lifecycle';
import { SkodaApiClient, type ApiResult } from './api/client';
import type { VehicleResponse } from './api/types';
import { PollScheduler } from './scheduler/PollScheduler';
import { CommandQueue } from './commands/CommandQueue';
import { VehicleQuotaManager } from './quota/VehicleQuotaManager';
import { testConnection } from './connectionTest';
import { StateWriter } from './states/StateWriter';
import { FakeAdapter } from '../../test/helpers/fakeAdapter';

const vinA = 'TMBJB9NY5RF999999';
const vinB = 'TMBJB9NY5RF888888';
const success: ApiResult<VehicleResponse> = { ok: true, data: { vehicle: {} }, meta: { consumedQuota: true } };
const deferred = <T>(): { promise: Promise<T>; resolve: (value: T) => void } => {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>(done => {
		resolve = done;
	});
	return { promise, resolve };
};
const recording = (): {
	lines: string[];
	debug: (s: string) => void;
	info: (s: string) => void;
	warn: (s: string) => void;
	error: (s: string) => void;
} => {
	const lines: string[] = [];
	const add = (s: string): void => {
		lines.push(s);
	};
	return { lines, debug: add, info: add, warn: add, error: add };
};
const timers = (): {
	handles: Set<unknown>;
	setTimer: (handler: () => void) => unknown;
	clearTimer: (handle: unknown) => void;
} => {
	const handles = new Set<unknown>();
	return {
		handles,
		setTimer: handler => {
			handles.add(handler);
			return handler;
		},
		clearTimer: handle => {
			handles.delete(handle);
		},
	};
};

describe('Compact mode shutdown and isolation', () => {
	it('keeps concurrent catalogs independent, with system, English and literal placeholder fallbacks', async () => {
		const root = join(__dirname, '..', '..');
		const [de, en, system, unknown] = await Promise.all([
			createTranslator(root, 'de'),
			createTranslator(root, 'en'),
			createTranslator(root, 'system', 'de'),
			createTranslator(root, '../missing'),
		]);
		for (let i = 0; i < 3; i++) {
			expect(de('No vehicle entered.')).to.equal('Kein Fahrzeug eingetragen.');
			expect(en('No vehicle entered.')).to.equal('No vehicle entered.');
			expect(system('No vehicle entered.')).to.equal(de('No vehicle entered.'));
		}
		expect(unknown('No vehicle entered.')).to.equal('No vehicle entered.');
		expect(de('Missing %s %s', '$&', null)).to.equal('Missing $& null');
		expect(de('toString')).to.equal('toString');
	});

	it('never starts a scheduled poll after stop, even if its cancelled callback is delivered', async () => {
		let requests = 0;
		const timer = timers();
		const scheduler = new PollScheduler({
			client: {
				getVehicle: () => {
					requests++;
					return Promise.resolve(success);
				},
			},
			quota: new VehicleQuotaManager({ vins: [vinA] }),
			vins: [vinA],
			log: recording(),
			...timer,
			onVehicleData: () => undefined,
		});
		scheduler.start();
		const callback = [...timer.handles][0] as () => void;
		await scheduler.shutdown();
		callback();
		await scheduler.tick();
		expect(requests).to.equal(0);
		expect(timer.handles.size).to.equal(0);
	});

	it('drains immediate command reports that are outside the send queue', async () => {
		const report = deferred<void>();
		const entered = deferred<void>();
		const queue = new CommandQueue({
			client: {
				sendCommand: () => {
					throw new Error('No command expected');
				},
			},
			quota: new VehicleQuotaManager({ vins: [vinA] }),
			vins: [vinA],
			log: recording(),
			onReport: () => {
				entered.resolve();
				return report.promise;
			},
		});
		queue.updateFromResponse(vinA, { vehicle: { charging: { status: { state: 'CHARGING' } } } } as VehicleResponse);
		const submitted = queue.submit(`${vinA}.charging.enabled`, true);
		await entered.promise;
		let finished = false;
		const stopped = queue.shutdown().then(() => {
			finished = true;
		});
		await Promise.resolve();
		expect(finished).to.equal(false);
		report.resolve();
		await Promise.all([submitted, stopped]);
		expect(finished).to.equal(true);
	});

	it('stops planned polls and ignores late results without callbacks or quota changes', async () => {
		const wait = deferred<ApiResult<VehicleResponse>>();
		const quota = new VehicleQuotaManager({ vins: [vinA] });
		const timer = timers();
		const log = recording();
		const calls: string[] = [];
		const scheduler = new PollScheduler({
			client: { getVehicle: () => wait.promise },
			quota,
			vins: [vinA],
			log,
			...timer,
			onVehicleData: () => {
				calls.push('data');
			},
			onResponse: () => calls.push('response'),
			onConnectionChange: () => calls.push('connection'),
		});
		scheduler.start();
		const task = scheduler.tick();
		const before = quota.snapshot(vinA);
		const stopped = scheduler.shutdown();
		expect(timer.handles.size).to.equal(0);
		wait.resolve(success);
		await Promise.all([task, stopped, scheduler.shutdown()]);
		await scheduler.tick();
		scheduler.requestVerificationPoll(vinA);
		scheduler.start();
		expect(calls).to.deep.equal([]);
		expect(quota.snapshot(vinA)).to.deep.equal(before);
		expect(log.lines).to.deep.equal([]);
		expect(timer.handles.size).to.equal(0);
	});

	it('drops waiting commands and drains a running command without reports or verification', async () => {
		const wait = deferred<ApiResult<void>>();
		const entered = deferred<void>();
		const quota = new VehicleQuotaManager({ vins: [vinA, vinB] });
		const timer = timers();
		const log = recording();
		const calls: string[] = [];
		const queue = new CommandQueue({
			client: {
				sendCommand: () => {
					entered.resolve();
					return wait.promise;
				},
			},
			quota,
			vins: [vinA, vinB],
			log,
			...timer,
			onReport: () => {
				calls.push('report');
			},
			onResponse: () => calls.push('response'),
			onCommandSent: () => calls.push('verify'),
			onConnectionChange: () => calls.push('connection'),
		});
		queue.start();
		const first = queue.submit(`${vinA}.charging.start`, true);
		await entered.promise;
		const second = queue.submit(`${vinB}.charging.start`, true);
		const before = quota.snapshot(vinA);
		const stopped = queue.shutdown();
		wait.resolve({ ok: true, data: undefined, meta: { consumedQuota: true } });
		await Promise.all([first, second, stopped, queue.shutdown()]);
		await queue.submit(`${vinA}.charging.start`, true);
		expect(queue.pending).to.equal(0);
		expect(calls).to.deep.equal([]);
		expect(log.lines).to.deep.equal([]);
		expect(timer.handles.size).to.equal(0);
		expect(quota.snapshot(vinA)).to.deep.equal(before);
	});

	it('blocks every write boundary of an active StateWriter and drains callbacks', async () => {
		const lifecycle = new Lifecycle();
		const adapter = new FakeAdapter();
		const entered = deferred<void>();
		const resume = deferred<void>();
		let writes = 0;
		adapter.setObjectNotExistsAsync = async () => {
			writes++;
			entered.resolve();
			await resume.promise;
			return { id: vinA };
		};
		const writer = new StateWriter({ api: lifecycle.guard(adapter) });
		const errors: unknown[] = [];
		lifecycle.run(
			() => writer.write(vinA, { vehicle: { vin: vinA } }),
			error => errors.push(error),
		);
		await entered.promise;
		lifecycle.stopping = true;
		resume.resolve();
		await lifecycle.drain();
		expect(writes).to.equal(1);
		expect(errors).to.deep.equal([]);
	});

	describe('real HTTP cancellation', () => {
		let server: Server;
		let baseUrl: string;
		let received: ReturnType<typeof deferred<void>>;
		const requests: Array<{ key: string | undefined; url: string | undefined }> = [];
		beforeEach(async () => {
			received = deferred<void>();
			requests.length = 0;
			server = createServer((req, res) => {
				requests.push({ key: req.headers['x-api-key'] as string, url: req.url });
				if (req.headers['x-api-key'] === 'hold') {
					res.writeHead(200, { 'Content-Type': 'application/json' });
					res.write('{');
					received.resolve();
				} else {
					res.end(JSON.stringify({ vehicle: {} }));
				}
			});
			server.listen(0, '127.0.0.1');
			await once(server, 'listening');
			const address = server.address();
			if (!address || typeof address === 'string') {
				throw new Error('Missing server address');
			}
			baseUrl = `http://127.0.0.1:${address.port}`;
		});
		afterEach(async () => {
			server.closeAllConnections();
			await new Promise<void>(resolve => server.close(() => resolve()));
		});
		it('aborts an unfinished response body promptly and preserves timeout behavior', async () => {
			const client = new SkodaApiClient({ apiKey: 'hold', baseUrl });
			const request = client.getVehicle(vinA);
			await received.promise;
			const before = Date.now();
			client.abort();
			client.abort();
			await rejects(request, ShutdownError);
			expect(Date.now() - before).to.be.lessThan(1000);
			await rejects(client.getVehicle(vinA), ShutdownError);
			const timeout = new SkodaApiClient({ apiKey: 'hold', baseUrl, timeoutMs: 30 });
			const result = await timeout.getVehicle(vinA);
			expect(result.ok).to.equal(false);
			if (!result.ok) {
				expect(result.error.kind).to.equal('network-error');
			}
			timeout.abort();
		});
		it('stops one instance while another continues with separate keys, VINs, timers, queues and quotas; restarts in process', async () => {
			const build = (
				vin: string,
				apiKey: string,
			): {
				client: SkodaApiClient;
				quota: VehicleQuotaManager;
				timer: ReturnType<typeof timers>;
				scheduler: PollScheduler;
				queue: CommandQueue;
				log: ReturnType<typeof recording>;
				writes: () => number;
			} => {
				const client = new SkodaApiClient({ apiKey, baseUrl });
				const quota = new VehicleQuotaManager({ vins: [vin] });
				const timer = timers();
				const log = recording();
				let writes = 0;
				const scheduler = new PollScheduler({
					client,
					quota,
					vins: [vin],
					log,
					...timer,
					onVehicleData: () => {
						writes++;
					},
				});
				const queue = new CommandQueue({
					client,
					quota,
					vins: [vin],
					log,
					...timer,
					onReport: () => {
						writes++;
					},
				});
				scheduler.start();
				queue.start();
				return { client, quota, timer, scheduler, queue, log, writes: () => writes };
			};
			const a = build(vinA, 'hold');
			const b = build(vinB, 'other');
			const poll = a.scheduler.tick();
			await received.promise;
			await Promise.all([a.scheduler.shutdown(), a.queue.shutdown(), poll]);
			await b.scheduler.tick();
			expect(a.writes()).to.equal(0);
			expect(a.log.lines).to.deep.equal([]);
			expect(a.timer.handles.size).to.equal(0);
			expect(b.writes()).to.equal(1);
			expect(b.timer.handles.size).to.equal(1);
			expect(a.quota.snapshot(vinA).inFlight).to.equal(1);
			expect(b.quota.snapshot(vinB).inFlight).to.equal(0);
			const restarted = build(vinA, 'new');
			await restarted.scheduler.tick();
			expect(restarted.writes()).to.equal(1);
			expect(requests.map(r => [r.key, r.url])).to.deep.equal([
				['hold', `/api/v1/vehicles/${vinA}`],
				['other', `/api/v1/vehicles/${vinB}`],
				['new', `/api/v1/vehicles/${vinA}`],
			]);
			await Promise.all([
				b.scheduler.shutdown(),
				b.queue.shutdown(),
				restarted.scheduler.shutdown(),
				restarted.queue.shutdown(),
			]);
		});
		it('aborts an active queue HTTP request with no report, verification or API error log', async () => {
			const client = new SkodaApiClient({ apiKey: 'hold', baseUrl });
			const log = recording();
			const callbacks: string[] = [];
			const queue = new CommandQueue({
				client,
				quota: new VehicleQuotaManager({ vins: [vinA] }),
				vins: [vinA],
				log,
				onReport: () => {
					callbacks.push('report');
				},
				onCommandSent: () => callbacks.push('verify'),
				onResponse: () => callbacks.push('expiry'),
			});
			const command = queue.submit(`${vinA}.charging.start`, true);
			await received.promise;
			await Promise.all([queue.shutdown(), queue.shutdown(), command]);
			expect(callbacks).to.deep.equal([]);
			expect(log.lines).to.deep.equal([]);
		});

		it('cancels connection tests without quota/expiry callbacks', async () => {
			const client = new SkodaApiClient({ apiKey: 'hold', baseUrl });
			const callbacks: string[] = [];
			const request = testConnection(client, vinA, Date.now(), {
				testedKey: 'hold',
				activeKey: 'hold',
				onResponse: () => {
					callbacks.push('expiry');
				},
			});
			await received.promise;
			client.abort();
			await rejects(request, ShutdownError);
			expect(callbacks).to.deep.equal([]);
		});
	});
});
