import { expect } from 'chai';
import { canonicalJson } from './chargingControls';
import { DEFAULT_API_KEY, DEFAULT_VIN, MockSkodaApi } from '../../../test/mock/server';
import { SkodaApiClient, type ApiResult } from '../api/client';
import type { CommandAction, CommandDomain, VehicleResponse } from '../api/types';
import { httpApiError } from '../api/errors';
import { QuotaManager } from '../quota/QuotaManager';
import { quotaForVehicle } from '../quota/VehicleQuotaManager';
import type { CommandReport } from '../states/commandDefs';
import { CommandQueue, type CommandLog, type CommandSender } from './CommandQueue';
import type { CommandBody } from './commandMap';
import type { CommandConfirmation } from './confirmation';

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
	let confirmations: Array<{ vin: string; confirmation: CommandConfirmation }>;

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
			quota: quotaForVehicle(DEFAULT_VIN, quota),
			vins: [DEFAULT_VIN],
			onReport: (vin, report) => {
				reports.push([vin, report]);
			},
			onCommandSent: vin => verified.push(vin),
			onConfirmation: (vin, confirmation) => confirmations.push({ vin, confirmation }),
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
		confirmations = [];
		queue = buildQueue();
	});

	afterEach(async () => {
		queue.stop();
		await mock.stop();
	});

	describe('visible command confirmation without additional API calls', () => {
		const status = (): string[] => confirmations.map(entry => entry.confirmation.status);
		const poll = (state: string, captured = clock): VehicleResponse => ({
			vehicle: {
				charging: {
					isVehicleInSavedLocation: false,
					carCapturedTimestamp: new Date(captured).toISOString(),
					status: { state },
				},
			},
		});

		it('distinguishes API acceptance from matching newer vehicle data and leaves lastCommand unchanged', async () => {
			await queue.submit(`${DEFAULT_VIN}.charging.enabled`, true);
			const sentAt = clock;
			expect(confirmations[0]).to.deep.equal({
				vin: DEFAULT_VIN,
				confirmation: {
					channel: 'charging',
					name: 'charging.start',
					target: 'true',
					sentAt,
					expiresAt: sentAt + 10 * MINUTE,
					confirmedAt: 0,
					status: 'WAITING',
				},
			});
			queue.updateFromResponse(DEFAULT_VIN, poll('CHARGING'));
			clock += MINUTE;
			queue.updateFromResponse(DEFAULT_VIN, poll('READY_FOR_CHARGING'));
			expect(status()).to.deep.equal(['WAITING']);
			queue.updateFromResponse(DEFAULT_VIN, poll('CHARGING'));
			expect(status()).to.deep.equal(['WAITING', 'CONFIRMED']);
			expect(confirmations[1].confirmation.confirmedAt).to.equal(clock);
			queue.updateFromResponse(DEFAULT_VIN, poll('CHARGING'));
			expect(confirmations).to.have.length(2);
			expect(results()).to.deep.equal(['SENT']);
			expect(verified).to.deep.equal([DEFAULT_VIN]);
			expect(mock.requests).to.have.length(1);
			expect(quota.snapshot().remaining).to.equal(19);
		});

		it('does not confirm missing or failed parts, unrelated timestamps or unknown stop states', async () => {
			await queue.submit(`${DEFAULT_VIN}.charging.stop`, true);
			clock += MINUTE;
			queue.updateFromResponse(DEFAULT_VIN, {
				vehicle: { odometer: { mileageInKm: 1, carCapturedTimestamp: new Date(clock).toISOString() } },
			});
			const failed = poll('READY_FOR_CHARGING');
			failed.errors = [{ type: 'CHARGING_UNAVAILABLE' }];
			queue.updateFromResponse(DEFAULT_VIN, failed);
			const nested: any = poll('READY_FOR_CHARGING', clock - MINUTE);
			nested.vehicle.charging.status.carCapturedTimestamp = new Date(clock).toISOString();
			queue.updateFromResponse(DEFAULT_VIN, nested);
			for (const value of ['UNKNOWN', 'UNSUPPORTED', 'FUTURE_STATE']) {
				queue.updateFromResponse(DEFAULT_VIN, poll(value));
			}
			expect(status()).to.deep.equal(['WAITING']);
			queue.updateFromResponse(DEFAULT_VIN, poll('READY_FOR_CHARGING'));
			expect(status()).to.deep.equal(['WAITING', 'CONFIRMED']);
			expect(mock.requests).to.have.length(1);
		});

		it('expires locally without quota acquisition, verification requests or resending', async () => {
			const timers = new Map<number, { handler: () => void; ms: number }>();
			let sequence = 0;
			let acquired = 0;
			const budget = quotaForVehicle(DEFAULT_VIN, quota);
			queue = buildQueue({
				quota: {
					...budget,
					tryAcquire: (vin, priority) => {
						acquired++;
						return budget.tryAcquire(vin, priority);
					},
				},
				setTimer: (handler, ms) => {
					timers.set(++sequence, { handler, ms });
					return sequence;
				},
				clearTimer: handle => {
					timers.delete(handle as number);
				},
			});
			queue.start();
			await queue.submit(`${DEFAULT_VIN}.charging.enabled`, true);
			const before = quota.snapshot();
			expect(timers.size).to.equal(1);
			const [id, timer] = [...timers][0];
			expect(timer.ms).to.equal(10 * MINUTE);
			clock += timer.ms;
			timers.delete(id);
			timer.handler();
			expect(status()).to.deep.equal(['WAITING', 'TIMED_OUT']);
			expect(timers.size).to.equal(0);
			expect(acquired).to.equal(1);
			expect(mock.requests).to.have.length(1);
			expect(quota.snapshot()).to.deep.equal(before);
			expect(verified).to.deep.equal([DEFAULT_VIN]);
			clock += MINUTE;
			queue.updateFromResponse(DEFAULT_VIN, poll('CHARGING'));
			expect(status()).to.deep.equal(['WAITING', 'TIMED_OUT']);
		});

		it('preserves the deadline on coalesced writes and replaces it only on a newly accepted command', async () => {
			await queue.submit(`${DEFAULT_VIN}.charging.enabled`, true);
			clock += MINUTE;
			await queue.submit(`${DEFAULT_VIN}.charging.enabled`, true);
			expect(status()).to.deep.equal(['WAITING']);
			await queue.submit(`${DEFAULT_VIN}.charging.enabled`, false);
			expect(status()).to.deep.equal(['WAITING', 'WAITING']);
			expect(confirmations[1].confirmation).to.include({
				name: 'charging.stop',
				target: 'false',
				expiresAt: clock + 10 * MINUTE,
			});
			clock += MINUTE;
			queue.updateFromResponse(DEFAULT_VIN, poll('CHARGING'));
			expect(status()).to.deep.equal(['WAITING', 'WAITING']);
			queue.updateFromResponse(DEFAULT_VIN, poll('READY_FOR_CHARGING'));
			expect(status()).to.deep.equal(['WAITING', 'WAITING', 'CONFIRMED']);
		});

		it('keeps confirmations independent for mode, limit and profiles', async () => {
			mock.vehicleState.charging.settings.availableChargeModes = ['MANUAL', 'TIMER'];
			await feedPoll();
			const profile = structuredClone(mock.vehicleState.chargingProfiles.profiles[0]);
			profile.name = 'New profile name';
			await queue.submit(`${DEFAULT_VIN}.charging.settings.preferredChargeMode`, 'TIMER');
			await queue.submit(`${DEFAULT_VIN}.charging.settings.targetStateOfChargeInPercent`, 90);
			await queue.submit(`${DEFAULT_VIN}.chargingProfiles.profiles.1.configurationJson`, JSON.stringify(profile));
			expect(confirmations.map(entry => entry.confirmation.channel)).to.deep.equal([
				'chargingMode',
				'chargingLimit',
				'chargingProfiles.1',
			]);
			clock += MINUTE;
			const response = { vehicle: structuredClone(mock.vehicleState) };
			response.vehicle.charging.carCapturedTimestamp = new Date(clock).toISOString();
			queue.updateFromResponse(DEFAULT_VIN, response);
			expect(
				confirmations
					.filter(entry => entry.confirmation.status === 'CONFIRMED')
					.map(entry => entry.confirmation.channel),
			).to.have.members(['chargingMode', 'chargingLimit']);
			response.vehicle.chargingProfiles.carCapturedTimestamp = new Date(clock).toISOString();
			queue.updateFromResponse(DEFAULT_VIN, response);
			expect(confirmations[5].confirmation).to.include({ channel: 'chargingProfiles.1', status: 'CONFIRMED' });
			expect(JSON.parse(confirmations[5].confirmation.target)).to.deep.equal(profile);
			expect(mock.requests).to.have.length(4);
			expect(verified).to.have.length(3);
		});

		it('does not create confirmations for queued, invalid, rejected or already-reported targets', async () => {
			await feedPoll();
			await queue.submit(`${DEFAULT_VIN}.charging.enabled`, false);
			await queue.submit(`${DEFAULT_VIN}.charging.settings.targetStateOfChargeInPercent`, 85);
			mock.scenario = 'operation-disabled';
			await queue.submit(`${DEFAULT_VIN}.charging.start`, true);
			quota.recordResponse({ rateLimit: { limit: 20, remaining: 0, resetInSeconds: 60 }, consumedQuota: false });
			await queue.submit(`${DEFAULT_VIN}.charging.start`, true);
			expect(results()).to.deep.equal(['COALESCED', 'FAILED', 'REJECTED_BY_VEHICLE', 'QUEUED']);
			expect(confirmations).to.have.length(0);
		});

		it('cancels confirmation timers on shutdown and ignores stale callbacks', async () => {
			const timers = new Set<() => void>();
			queue = buildQueue({
				setTimer: handler => {
					timers.add(handler);
					return handler;
				},
				clearTimer: handle => {
					timers.delete(handle as () => void);
				},
			});
			queue.start();
			await queue.submit(`${DEFAULT_VIN}.charging.start`, true);
			const stale = [...timers][0];
			await queue.shutdown();
			expect(timers.size).to.equal(0);
			clock += 11 * MINUTE;
			stale();
			queue.updateFromResponse(DEFAULT_VIN, poll('CHARGING'));
			expect(status()).to.deep.equal(['WAITING']);
			expect(mock.requests).to.have.length(1);
		});
	});

	describe('invalid switch writes', () => {
		it('does not send, acknowledge, schedule verification or consume quota', async () => {
			const before = quota.snapshot();
			for (const domain of ['charging', 'airConditioning', 'auxiliaryHeating', 'activeVentilation']) {
				for (const value of ['true', 'false', '', 1, 0, NaN, null, undefined, {}, []]) {
					await queue.submit(`${DEFAULT_VIN}.${domain}.enabled`, value);
				}
			}
			expect(mock.requests).to.have.length(0);
			expect(reports).to.have.length(0);
			expect(verified).to.have.length(0);
			expect(queue.pending).to.equal(0);
			expect(quota.snapshot()).to.deep.equal(before);
		});

		it('preserves a valid queued start when an invalid value is written afterwards', async () => {
			quota.recordResponse({ rateLimit: { limit: 20, remaining: 0, resetInSeconds: 60 }, consumedQuota: false });
			await queue.submit(`${DEFAULT_VIN}.charging.enabled`, true);
			await queue.submit(`${DEFAULT_VIN}.charging.enabled`, 'true');
			await queue.submit(`${DEFAULT_VIN}.charging.enabled`, null);
			expect(results()).to.deep.equal(['QUEUED']);
			expect(queue.pending).to.equal(1);
			clock += 61_000;
			await queue.tick();
			expect(results()).to.deep.equal(['QUEUED', 'SENT']);
			expect(mock.requests).to.have.length(1);
			expect(mock.requests[0].path).to.equal(`/api/v1/vehicles/${DEFAULT_VIN}/charging/start`);
		});
	});

	describe('charging mode and complete profiles', () => {
		const modePath = `${DEFAULT_VIN}.charging.settings.preferredChargeMode`;
		const profilePath = (id = 1): string => `${DEFAULT_VIN}.chargingProfiles.profiles.${id}.configurationJson`;
		const currentProfile = (): any => structuredClone(mock.vehicleState.chargingProfiles.profiles[0]);
		const queueWindow = (): void => {
			quota.recordResponse({ rateLimit: { limit: 20, remaining: 0, resetInSeconds: 60 }, consumedQuota: false });
		};

		beforeEach(async () => {
			mock.vehicleState.charging.settings.availableChargeModes = ['MANUAL', 'TIMER'];
			await feedPoll();
			mock.requests.length = 0;
		});

		it('rejects an editor snapshot that changed before admission without consuming quota', async () => {
			const original = currentProfile();
			mock.vehicleState.chargingProfiles.profiles[0].name = 'Changed externally';
			await feedPoll();
			mock.requests.length = 0;
			await queue.submit(profilePath(), JSON.stringify({ ...original, name: 'Draft' }), canonicalJson(original));
			expect(results()).to.deep.equal(['FAILED']);
			expect(mock.requests).to.have.length(0);
		});

		it('prevents an editor from overwriting an unresolved profile command and coalesces repeated apply', async () => {
			const original = currentProfile();
			const target = JSON.stringify({ ...original, name: 'Draft' });
			await queue.submit(profilePath(), target, canonicalJson(original));
			await queue.submit(profilePath(), target, canonicalJson(original));
			await queue.submit(
				profilePath(),
				JSON.stringify({ ...original, name: 'Another draft' }),
				canonicalJson(original),
			);
			expect(results()).to.deep.equal(['SENT', 'COALESCED', 'FAILED']);
			expect(mock.requests).to.have.length(1);
		});

		it('allows a changed editor target after an unresolved command expires', async () => {
			const original = currentProfile();
			await queue.submit(profilePath(), JSON.stringify({ ...original, name: 'First' }), canonicalJson(original));
			clock += 11 * MINUTE;
			await queue.submit(profilePath(), JSON.stringify({ ...original, name: 'Retry' }), canonicalJson(original));
			expect(results()).to.deep.equal(['SENT', 'SENT']);
			expect(mock.requests).to.have.length(2);
		});

		it('sends mode with PUT and coalesces repeats until a newer poll confirms it', async () => {
			await queue.submit(modePath, 'TIMER');
			await queue.submit(modePath, 'TIMER');
			expect(results()).to.deep.equal(['SENT', 'COALESCED']);
			expect(mock.requests).to.have.length(1);
			expect(mock.requests[0]).to.include({
				method: 'PUT',
				path: `/api/v1/vehicles/${DEFAULT_VIN}/charging/mode`,
			});
			expect(mock.vehicleState.charging.settings.preferredChargeMode).to.equal('TIMER');
			expect(verified).to.deep.equal([DEFAULT_VIN]);
			expect(last().acknowledge).to.deep.equal({ path: 'charging.settings.preferredChargeMode', value: 'TIMER' });
			clock += 1000;
			mock.vehicleState.charging.carCapturedTimestamp = new Date(clock).toISOString();
			await feedPoll();
			mock.vehicleState.charging.settings.preferredChargeMode = 'MANUAL';
			clock += 1000;
			mock.vehicleState.charging.carCapturedTimestamp = new Date(clock).toISOString();
			await feedPoll();
			await queue.submit(modePath, 'TIMER');
			expect(last().result).to.equal('SENT');
		});

		it('rejects unsupported modes and invalid profiles locally without altering pending commands', async () => {
			queueWindow();
			await queue.submit(modePath, 'TIMER');
			for (const value of ['UNKNOWN', 'ONLY_OWN_CURRENT', 'timer', true, null, 1]) {
				await queue.submit(modePath, value);
				expect(last().result).to.equal('FAILED');
			}
			for (const value of ['{', '{}', 'null', JSON.stringify({ ...currentProfile(), id: 2 })]) {
				await queue.submit(profilePath(), value);
				expect(last().result).to.equal('FAILED');
			}
			expect(mock.requests).to.have.length(0);
			expect(queue.pending).to.equal(1);
			expect(verified).to.have.length(0);
			expect(last().acknowledge).to.equal(undefined);
		});

		it('sends the complete profile, retaining unchanged settings, timers and additional fields', async () => {
			const profile = currentProfile();
			profile.name = 'New name';
			profile.futureField = { value: 42 };
			await queue.submit(profilePath(), JSON.stringify(profile));
			expect(last().result).to.equal('SENT');
			expect(mock.requests[0]).to.include({
				method: 'PUT',
				path: `/api/v1/vehicles/${DEFAULT_VIN}/charging-profiles/1`,
			});
			expect(mock.vehicleState.chargingProfiles.profiles[0]).to.deep.equal(profile);
			expect(JSON.parse(String(last().acknowledge?.value))).to.deep.equal(profile);
			expect(verified).to.deep.equal([DEFAULT_VIN]);
			await queue.submit(profilePath(), JSON.stringify(Object.fromEntries(Object.entries(profile).reverse())));
			expect(last().result).to.equal('COALESCED');
			expect(mock.requests).to.have.length(1);
		});

		it('coalesces an unchanged profile from the last poll', async () => {
			await queue.submit(profilePath(), JSON.stringify(currentProfile()));
			expect(results()).to.deep.equal(['COALESCED']);
			expect(mock.requests).to.have.length(0);
		});

		it('queues each profile independently of mode, limit and start/stop, replacing only the same profile', async () => {
			const first = currentProfile();
			const second = { ...structuredClone(first), id: 2 };
			mock.vehicleState.chargingProfiles.profiles.push(second);
			await feedPoll();
			mock.requests.length = 0;
			queueWindow();
			await queue.submit(profilePath(), JSON.stringify({ ...first, name: 'First' }));
			await queue.submit(profilePath(2), JSON.stringify({ ...second, name: 'Second' }));
			await queue.submit(profilePath(), JSON.stringify({ ...first, name: 'Replacement' }));
			await queue.submit(modePath, 'TIMER');
			await queue.submit(`${DEFAULT_VIN}.charging.settings.targetStateOfChargeInPercent`, 90);
			await queue.submit(`${DEFAULT_VIN}.charging.enabled`, true);
			expect(queue.pending).to.equal(5);
			clock += 61_000;
			await queue.tick();
			expect(mock.requests).to.have.length(5);
			expect(mock.vehicleState.chargingProfiles.profiles.map((p: any) => p.name)).to.deep.equal([
				'Replacement',
				'Second',
			]);
			expect(mock.vehicleState.charging.settings.preferredChargeMode).to.equal('TIMER');
			expect(mock.vehicleState.charging.settings.targetStateOfChargeInPercent).to.equal(90);
		});

		for (const change of ['changed', 'removed', 'omitted'] as const) {
			it(`rejects a queued profile when it is ${change} in a subsequent poll`, async () => {
				const profile = currentProfile();
				queueWindow();
				await queue.submit(profilePath(), JSON.stringify({ ...profile, name: 'Requested' }));
				const response = { vehicle: structuredClone(mock.vehicleState) };
				if (change === 'changed') {
					response.vehicle.chargingProfiles.profiles[0].settings.maxChargingCurrent = 'MAXIMUM';
				} else if (change === 'removed') {
					response.vehicle.chargingProfiles.profiles = [];
				} else {
					delete response.vehicle.chargingProfiles;
				}
				queue.updateFromResponse(DEFAULT_VIN, response);
				clock += 61_000;
				await queue.tick();
				expect(results()).to.deep.equal(['QUEUED', 'FAILED']);
				expect(mock.requests).to.have.length(0);
				expect(queue.pending).to.equal(0);
			});
		}

		it('revalidates mode availability before spending quota', async () => {
			queueWindow();
			await queue.submit(modePath, 'TIMER');
			const response = { vehicle: structuredClone(mock.vehicleState) };
			response.vehicle.charging.settings.availableChargeModes = ['MANUAL'];
			queue.updateFromResponse(DEFAULT_VIN, response);
			clock += 61_000;
			await queue.tick();
			expect(results()).to.deep.equal(['QUEUED', 'FAILED']);
			expect(mock.requests).to.have.length(0);
		});

		it('rejects an unknown profile and requires a successful poll after restart', async () => {
			await queue.submit(profilePath(2), JSON.stringify({ ...currentProfile(), id: 2 }));
			expect(last().result).to.equal('FAILED');
			queue.stop();
			queue = buildQueue();
			await queue.submit(modePath, 'TIMER');
			await queue.submit(profilePath(), JSON.stringify(currentProfile()));
			expect(results()).to.deep.equal(['FAILED', 'FAILED', 'FAILED']);
			expect(mock.requests).to.have.length(0);
		});

		it('allows manual retries after confirmation expiry without discarding profile validation data', async () => {
			const profile = { ...currentProfile(), name: 'Pending name' };
			await queue.submit(profilePath(), JSON.stringify(profile));
			await queue.submit(modePath, 'TIMER');
			clock += 11 * MINUTE;
			// No confirming poll has refreshed the originally reported snapshots.
			await queue.submit(profilePath(), JSON.stringify(profile));
			await queue.submit(modePath, 'TIMER');
			expect(results()).to.deep.equal(['SENT', 'SENT', 'SENT', 'SENT']);
			expect(mock.requests).to.have.length(4);
		});

		it('confirms a profile with a newer timestamp and accepts a later change back to an earlier target', async () => {
			const profile = { ...currentProfile(), name: 'Confirmed name' };
			await queue.submit(profilePath(), JSON.stringify(profile));
			clock += 1000;
			mock.vehicleState.chargingProfiles.carCapturedTimestamp = new Date(clock).toISOString();
			await feedPoll();
			mock.vehicleState.chargingProfiles.profiles[0].name = 'Changed in app';
			clock += 1000;
			mock.vehicleState.chargingProfiles.carCapturedTimestamp = new Date(clock).toISOString();
			await feedPoll();
			await queue.submit(profilePath(), JSON.stringify(profile));
			expect(results()).to.deep.equal(['SENT', 'SENT']);
		});

		it('keeps a rejected mode independent of supported start/stop and profile operations', async () => {
			mock.scenario = 'operation-not-supported';
			await queue.submit(modePath, 'TIMER');
			expect(last().result).to.equal('REJECTED_BY_VEHICLE');
			expect(last().acknowledge).to.equal(undefined);
			mock.scenario = 'ok';
			await queue.submit(`${DEFAULT_VIN}.charging.enabled`, true);
			await queue.submit(profilePath(), JSON.stringify({ ...currentProfile(), name: 'Still supported' }));
			expect(results()).to.deep.equal(['REJECTED_BY_VEHICLE', 'SENT', 'SENT']);
		});
	});

	describe('charging limit', () => {
		it('sends the limit via PUT, acknowledges it and schedules verification', async () => {
			await queue.submit(`${DEFAULT_VIN}.charging.settings.targetStateOfChargeInPercent`, 90);
			expect(results()).to.deep.equal(['SENT']);
			expect(mock.requests[0]).to.include({
				method: 'PUT',
				path: `/api/v1/vehicles/${DEFAULT_VIN}/charging/limit`,
				status: 202,
			});
			expect(last().acknowledge).to.deep.equal({
				path: 'charging.settings.targetStateOfChargeInPercent',
				value: 90,
			});
			expect(verified).to.deep.equal([DEFAULT_VIN]);
			const response = await client.getVehicle(DEFAULT_VIN);
			if (!response.ok) {
				throw new Error('Poll failed');
			}
			expect(response.data.vehicle.charging?.settings?.targetStateOfChargeInPercent).to.equal(90);
		});

		for (const value of [0, 1, 40, 49, 51, 55, 85, 99, 101, 110, 85.5, NaN, Infinity, '90', true, null]) {
			it(`rejects invalid limit ${String(value)} without an API call`, async () => {
				await queue.submit(`${DEFAULT_VIN}.charging.settings.targetStateOfChargeInPercent`, value);
				expect(results()).to.deep.equal(['FAILED']);
				expect(mock.requests).to.have.length(0);
				expect(last().acknowledge).to.equal(undefined);
			});
		}

		it('accepts all six charging limits in ten-percent steps', async () => {
			for (const value of [50, 60, 70, 80, 90, 100]) {
				await queue.submit(`${DEFAULT_VIN}.charging.settings.targetStateOfChargeInPercent`, value);
				expect(last().result).to.equal('SENT');
			}
		});

		it('coalesces reported and outstanding limits but permits a changed target', async () => {
			queue.updateFromResponse(DEFAULT_VIN, {
				vehicle: {
					vin: DEFAULT_VIN,
					charging: { isVehicleInSavedLocation: false, settings: { targetStateOfChargeInPercent: 80 } },
				},
			});
			await queue.submit(`${DEFAULT_VIN}.charging.settings.targetStateOfChargeInPercent`, 80);
			await queue.submit(`${DEFAULT_VIN}.charging.settings.targetStateOfChargeInPercent`, 90);
			await queue.submit(`${DEFAULT_VIN}.charging.settings.targetStateOfChargeInPercent`, 90);
			await queue.submit(`${DEFAULT_VIN}.charging.settings.targetStateOfChargeInPercent`, 80);
			expect(results()).to.deep.equal(['COALESCED', 'SENT', 'COALESCED', 'SENT']);
		});

		it('keeps an unsupported limit from disabling charging start', async () => {
			mock.scenario = 'operation-not-supported';
			await queue.submit(`${DEFAULT_VIN}.charging.settings.targetStateOfChargeInPercent`, 90);
			mock.scenario = 'ok';
			await queue.submit(`${DEFAULT_VIN}.charging.settings.targetStateOfChargeInPercent`, 100);
			await queue.submit(`${DEFAULT_VIN}.charging.enabled`, true);
			expect(results()).to.deep.equal(['REJECTED_BY_VEHICLE', 'REJECTED_BY_VEHICLE', 'SENT']);
			expect(mock.requests).to.have.length(2);
		});

		it('allows retry after confirmation and a subsequent external limit change', async () => {
			await queue.submit(`${DEFAULT_VIN}.charging.settings.targetStateOfChargeInPercent`, 90);
			clock += 1000;
			const charging = {
				isVehicleInSavedLocation: false,
				carCapturedTimestamp: new Date(clock).toISOString(),
				settings: { targetStateOfChargeInPercent: 90 },
			};
			queue.updateFromResponse(DEFAULT_VIN, { vehicle: { vin: DEFAULT_VIN, charging } });
			clock += 1000;
			queue.updateFromResponse(DEFAULT_VIN, {
				vehicle: {
					vin: DEFAULT_VIN,
					charging: {
						...charging,
						carCapturedTimestamp: new Date(clock).toISOString(),
						settings: { targetStateOfChargeInPercent: 80 },
					},
				},
			});
			await queue.submit(`${DEFAULT_VIN}.charging.settings.targetStateOfChargeInPercent`, 90);
			expect(results()).to.deep.equal(['SENT', 'SENT']);
		});

		it('queues start/stop independently and replaces only pending limits', async () => {
			quota.recordResponse({ rateLimit: { limit: 20, remaining: 0, resetInSeconds: 60 }, consumedQuota: false });
			await queue.submit(`${DEFAULT_VIN}.charging.settings.targetStateOfChargeInPercent`, 90);
			await queue.submit(`${DEFAULT_VIN}.charging.enabled`, true);
			await queue.submit(`${DEFAULT_VIN}.charging.settings.targetStateOfChargeInPercent`, 100);
			expect(queue.pending).to.equal(2);
			clock += MINUTE;
			await queue.tick();
			expect(mock.requests.map(request => request.method)).to.deep.equal(['PUT', 'POST']);
			const response = await client.getVehicle(DEFAULT_VIN);
			if (!response.ok) {
				throw new Error('Poll failed');
			}
			expect(response.data.vehicle.charging?.settings?.targetStateOfChargeInPercent).to.equal(100);
		});
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
			// Relevanter Ablauf: enabled=true, dann innerhalb der TTL
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
			expect(log.lines.some(line => line.includes('Result could not be written'))).to.equal(true);
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
