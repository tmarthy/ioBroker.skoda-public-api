import { expect } from 'chai';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { FakeAdapter } from '../../../test/helpers/fakeAdapter';
import type { VehicleResponse } from '../api/types';
import { QUALITY_NOT_GOOD, StateWriter, type StateApi } from './StateWriter';
import { generatedStateDefs } from './objectDefs.generated';
import { OBJECT_NAME_LANGUAGES } from '../i18n';
import type { CommandConfirmation } from '../commands/confirmation';

/**
 * Beweist zur Uebersetzungszeit, dass eine echte Adapter-Instanz die schmale
 * Schnittstelle erfuellt - sonst faellt das erst bei der Adapterverdrahtung auf.
 */
type AdapterErfuelltStateApi = ioBroker.Adapter extends StateApi ? true : false;

const FIXTURE_DIR = path.join(__dirname, '..', '..', '..', 'test', 'fixtures');
const VIN = 'TMBJB9NY5RF999999';

/**
 * Laedt eine anonymisierte Fahrzeugaufnahme.
 *
 * @param name Dateiname ohne `vehicle-` und ohne Endung.
 * @returns Der Antwortkoerper.
 */
function fixture(name: string): VehicleResponse {
	const raw = JSON.parse(readFileSync(path.join(FIXTURE_DIR, `vehicle-${name}.json`), 'utf8'));
	return raw.body as VehicleResponse;
}

/**
 * Sammelt alle Blattpfade eines Objekts, wie der Writer sie abschreiten wuerde.
 *
 * @param node Ein Teilbaum.
 * @param prefix Pfad bis hierher.
 * @returns Pfad und Wert je Blatt.
 */
function leaves(node: Record<string, unknown>, prefix = ''): Array<[string, unknown]> {
	const found: Array<[string, unknown]> = [];
	for (const [key, value] of Object.entries(node)) {
		const here = prefix ? `${prefix}.${key}` : key;
		if (value === null || value === undefined) {
			continue;
		}
		if (Array.isArray(value)) {
			found.push([here, JSON.stringify(value)]);
			continue;
		}
		if (typeof value === 'object') {
			found.push(...leaves(value as Record<string, unknown>, here));
			continue;
		}
		found.push([here, value]);
	}
	return found;
}

describe('states/StateWriter => Antwort in den Objektbaum', () => {
	let adapter: FakeAdapter;
	let writer: StateWriter;
	const clock = Date.parse('2026-09-02T18:15:00Z');

	beforeEach(() => {
		adapter = new FakeAdapter();
		writer = new StateWriter({ api: adapter, now: () => clock });
	});

	it('nimmt eine echte Adapter-Instanz an', () => {
		const beweis: AdapterErfuelltStateApi = true;
		expect(beweis).to.equal(true);
	});

	it('does not mark persisted local profile drafts as stale vehicle measurements', async () => {
		const id = `${VIN}.chargingProfiles.profiles.1.edit.name`;
		await adapter.setStateAsync(id, { val: 'Local draft', ack: true, q: 0 });
		await writer.write(VIN, fixture('charging'));
		expect(adapter.quality(id)).to.equal(0);
		expect(adapter.val(id)).to.equal('Local draft');
	});

	it('migrates diagnostic labels for the system language while keeping status codes and custom metadata', async () => {
		await writer.writePollingStatus(VIN, { reason: 'QUOTA', nextPollAt: 123 });
		await writer.writeCommandConfirmation(VIN, {
			channel: 'charging',
			name: 'charging.start',
			target: 'true',
			sentAt: 1,
			expiresAt: 2,
			confirmedAt: 2,
			status: 'CONFIRMED',
		});
		const reason = `${VIN}.info.polling.reason`;
		const confirmation = `${VIN}.info.commandConfirmation.charging.status`;
		await adapter.extendObjectAsync(reason, {
			common: { name: 'Mein Abfragestatus', custom: { 'history.0': { enabled: true } } },
		});
		writer = new StateWriter({ api: adapter, language: 'de' });
		await writer.interruptCommandConfirmations(VIN);
		await writer.writePollingStatus(VIN, { reason: 'QUOTA', nextPollAt: 123 });
		expect(adapter.objects.get(reason)!.common)
			.to.have.property('states')
			.that.has.property('QUOTA', 'Warten auf API-Kontingent');
		expect(adapter.objects.get(reason)!.common).to.have.property('name', 'Mein Abfragestatus');
		expect(adapter.objects.get(reason)!.common)
			.to.have.property('custom')
			.that.deep.equals({ 'history.0': { enabled: true } });
		expect(adapter.objects.get(confirmation)!.common)
			.to.have.property('states')
			.that.has.property('CONFIRMED', 'Passende neuere Fahrzeugdaten erkannt');
		expect(adapter.val(reason)).to.equal('QUOTA');
		expect(adapter.val(confirmation)).to.equal('CONFIRMED');
	});

	describe('command confirmation', () => {
		const accepted = (): CommandConfirmation => ({
			channel: 'charging',
			name: 'charging.start',
			target: 'true',
			sentAt: clock,
			expiresAt: clock + 600_000,
			confirmedAt: 0,
			status: 'WAITING',
		});

		it('writes read-only diagnostics without changing lastCommand or the control acknowledgement', async () => {
			await writer.writeCommandResult(VIN, {
				name: 'charging.start',
				result: 'SENT',
				timestamp: clock,
				acknowledge: { path: 'charging.enabled', value: true },
			});
			await writer.writeCommandConfirmation(VIN, accepted());
			await writer.writeCommandConfirmation(VIN, {
				...accepted(),
				status: 'CONFIRMED',
				confirmedAt: clock + 60_000,
			});
			const base = `${VIN}.info.commandConfirmation.charging`;
			expect(adapter.val(`${base}.status`)).to.equal('CONFIRMED');
			expect(adapter.val(`${base}.confirmedAt`)).to.equal(clock + 60_000);
			expect(JSON.parse(String(adapter.val(`${base}.target`)))).to.equal(true);
			expect(adapter.val(`${VIN}.info.lastCommand.result`)).to.equal('SENT');
			expect(adapter.states.get(`${VIN}.charging.enabled`)).to.include({ val: true, ack: true });
			for (const leaf of ['name', 'target', 'sentAt', 'expiresAt', 'confirmedAt', 'status']) {
				expect(adapter.objects.get(`${base}.${leaf}`)?.common).to.include({ read: true, write: false });
				expect(
					Object.keys(adapter.objects.get(`${base}.${leaf}`)?.common?.name as object).sort(),
				).to.deep.equal([...OBJECT_NAME_LANGUAGES].sort());
			}
			await writer.write(VIN, fixture('idle'));
			expect(adapter.quality(`${base}.status`)).to.equal(0);
		});

		it('serializes transitions and emits status last, including repeated WAITING for a replacement', async () => {
			const first = writer.writeCommandConfirmation(VIN, accepted());
			const second = writer.writeCommandConfirmation(VIN, {
				...accepted(),
				name: 'charging.stop',
				target: 'false',
				sentAt: clock + 1,
			});
			const third = writer.writeCommandConfirmation(VIN, {
				...accepted(),
				name: 'charging.stop',
				target: 'false',
				sentAt: clock + 1,
				status: 'TIMED_OUT',
			});
			await Promise.all([first, second, third]);
			const base = `${VIN}.info.commandConfirmation.charging`;
			expect(adapter.writes.filter(id => id === `${base}.status`)).to.have.length(3);
			expect(adapter.writes[adapter.writes.length - 1]).to.equal(`${base}.status`);
			expect(adapter.val(`${base}.target`)).to.equal('false');
			expect(adapter.val(`${base}.status`)).to.equal('TIMED_OUT');
		});

		it('marks only pending observations for the configured VIN as interrupted on restart', async () => {
			await writer.writeCommandConfirmation(VIN, accepted());
			await writer.writeCommandConfirmation(VIN, { ...accepted(), channel: 'chargingProfiles.1' });
			await writer.writeCommandConfirmation(VIN, {
				...accepted(),
				channel: 'chargingMode',
				status: 'CONFIRMED',
				confirmedAt: clock + 1,
			});
			await writer.writeCommandConfirmation('OTHER_VIN', accepted());
			await writer.interruptCommandConfirmations(VIN);
			expect(adapter.val(`${VIN}.info.commandConfirmation.charging.status`)).to.equal('INTERRUPTED');
			expect(adapter.val(`${VIN}.info.commandConfirmation.chargingProfiles.1.status`)).to.equal('INTERRUPTED');
			expect(adapter.val(`${VIN}.info.commandConfirmation.charging.sentAt`)).to.equal(clock);
			expect(adapter.val(`${VIN}.info.commandConfirmation.chargingMode.status`)).to.equal('CONFIRMED');
			expect(adapter.val('OTHER_VIN.info.commandConfirmation.charging.status')).to.equal('WAITING');
		});
	});

	describe('polling status', () => {
		it('initializes unknown success and keeps history across restarts and failed polls', async () => {
			const prefix = `${VIN}.info.polling`;
			await writer.writePollingStatus(VIN, { reason: 'STARTUP', nextPollAt: clock });
			expect(adapter.val(`${prefix}.lastSuccessfulPollAt`)).to.equal(0);
			await writer.writePollingStatus(VIN, {
				reason: 'IDLE_INTERVAL',
				nextPollAt: clock + 60_000,
				lastSuccessfulPollAt: clock,
			});
			const restarted = new StateWriter({ api: adapter });
			await restarted.writePollingStatus(VIN, { reason: 'STARTUP', nextPollAt: clock + 1000 });
			await restarted.writePollingStatus(VIN, { reason: 'AUTH_ERROR', nextPollAt: clock + 3_600_000 });
			expect(adapter.val(`${prefix}.lastSuccessfulPollAt`)).to.equal(clock);
			expect(adapter.val(`${prefix}.nextPollAt`)).to.equal(clock + 3_600_000);
			expect(adapter.val(`${prefix}.reason`)).to.equal('AUTH_ERROR');
			expect(adapter.objects.get(`${prefix}.nextPollAt`)?.common).to.include({
				type: 'number',
				role: 'date',
				write: false,
			});
			expect((adapter.objects.get(`${prefix}.reason`)?.common as ioBroker.StateCommon).states).to.have.property(
				'AUTH_ERROR',
			);
			for (const suffix of ['lastSuccessfulPollAt', 'nextPollAt', 'reason']) {
				expect(
					Object.keys(adapter.objects.get(`${prefix}.${suffix}`)?.common?.name as object).sort(),
				).to.deep.equal([...OBJECT_NAME_LANGUAGES].sort());
			}
			// Diagnostics must not fix the device name to a VIN before the first vehicle response.
			await writer.write(VIN, fixture('idle'));
			expect(adapter.objects.get(VIN)?.common?.name).to.equal('Enyaq');
			expect(adapter.quality(`${prefix}.reason`)).to.equal(0);
		});

		it('serializes slow diagnostic writes so the newest schedule wins', async () => {
			let release!: () => void;
			let entered!: () => void;
			const gate = new Promise<void>(resolve => {
				release = resolve;
			});
			const started = new Promise<void>(resolve => {
				entered = resolve;
			});
			const original = adapter.setStateChangedAsync.bind(adapter);
			adapter.setStateChangedAsync = async (id, state) => {
				if (id.endsWith('.nextPollAt') && state.val === 1) {
					entered();
					await gate;
				}
				return original(id, state);
			};
			const first = writer.writePollingStatus(VIN, { reason: 'STARTUP', nextPollAt: 1 });
			await started;
			const second = writer.writePollingStatus(VIN, {
				reason: 'IDLE_INTERVAL',
				nextPollAt: 2,
				lastSuccessfulPollAt: clock,
			});
			release();
			await Promise.all([first, second]);
			expect(adapter.val(`${VIN}.info.polling.nextPollAt`)).to.equal(2);
			expect(adapter.val(`${VIN}.info.polling.reason`)).to.equal('IDLE_INTERVAL');
		});

		it('recovers from a failed diagnostics write and keeps vehicle histories separate', async () => {
			const original = adapter.getStateAsync.bind(adapter);
			adapter.getStateAsync = () => Promise.reject(new Error('Storage unavailable'));
			await writer.writePollingStatus(VIN, { reason: 'STARTUP', nextPollAt: clock }).catch(() => undefined);
			adapter.getStateAsync = original;
			await writer.writePollingStatus(VIN, {
				reason: 'IDLE_INTERVAL',
				nextPollAt: clock + 60_000,
				lastSuccessfulPollAt: clock,
			});
			await writer.writePollingStatus('OTHER_VIN', { reason: 'SUSPENDED', nextPollAt: 0 });
			expect(adapter.val(`${VIN}.info.polling.lastSuccessfulPollAt`)).to.equal(clock);
			expect(adapter.val('OTHER_VIN.info.polling.lastSuccessfulPollAt')).to.equal(0);
			expect(adapter.val('OTHER_VIN.info.polling.nextPollAt')).to.equal(0);
		});
	});

	it('migrates charging mode and exposes a complete writable profile without changing user names', async () => {
		const modeId = `${VIN}.charging.settings.preferredChargeMode`;
		await adapter.setObjectNotExistsAsync(modeId, {
			type: 'state',
			common: { name: 'My mode', type: 'string', role: 'text', read: true, write: false },
			native: {},
		});
		const response = fixture('idle');
		await writer.write(VIN, response);
		expect(adapter.objects.get(modeId)?.common).to.include({ name: 'My mode', write: true });
		const id = `${VIN}.chargingProfiles.profiles.1.configurationJson`;
		expect(adapter.objects.get(id)?.common).to.include({ type: 'string', role: 'json', read: true, write: true });
		expect(JSON.parse(String(adapter.val(id)))).to.deep.equal(response.vehicle.chargingProfiles!.profiles[0]);
		await writer.writeCommandResult(VIN, {
			name: 'charging.mode',
			result: 'SENT',
			timestamp: clock,
			acknowledge: { path: 'charging.settings.preferredChargeMode', value: 'TIMER' },
		});
		expect(adapter.states.get(modeId)).to.include({ val: 'TIMER', ack: true });
		response.vehicle.chargingProfiles!.profiles = [];
		await writer.write(VIN, response);
		expect(adapter.quality(id)).to.equal(QUALITY_NOT_GOOD);
	});

	it('uses the reported charging setting as the writable limit', async () => {
		await writer.write(VIN, fixture('idle'));
		const id = `${VIN}.charging.settings.targetStateOfChargeInPercent`;
		expect(adapter.objects.get(id)?.common).to.include({
			type: 'number',
			write: true,
			min: 50,
			max: 100,
			step: 10,
			unit: '%',
		});
		expect(adapter.objects.has(`${VIN}.charging.targetStateOfChargeInPercent`)).to.equal(false);
		await writer.writeCommandResult(VIN, {
			name: 'charging.limit',
			result: 'SENT',
			timestamp: clock,
			acknowledge: { path: 'charging.settings.targetStateOfChargeInPercent', value: 90 },
		});
		expect(adapter.states.get(id)).to.include({ val: 90, ack: true });
	});

	for (const writable of [false, true]) {
		it(`migrates existing charging limits (write=${writable}) and preserves user metadata`, async () => {
			const id = `${VIN}.charging.settings.targetStateOfChargeInPercent`;
			await adapter.setObjectNotExistsAsync(id, {
				type: 'state',
				common: {
					name: 'Mein Ladelimit',
					type: 'number',
					read: true,
					write: writable,
					step: 1,
					role: 'value.battery',
					unit: '%',
					min: 0,
				},
				native: { custom: true },
			});
			await writer.write(VIN, fixture('idle'));
			expect(adapter.objects.get(id)?.common).to.include({
				name: 'Mein Ladelimit',
				write: true,
				role: 'level',
				min: 50,
				max: 100,
				step: 10,
			});
			expect(adapter.objects.get(id)?.native).to.deep.equal({ custom: true });
			await writer.writeCommandResult(VIN, {
				name: 'charging.limit',
				result: 'SENT',
				timestamp: clock,
				acknowledge: { path: 'charging.settings.targetStateOfChargeInPercent', value: 90 },
			});
			await writer.write(VIN, fixture('idle'));
			expect(adapter.val(id)).to.equal(fixture('idle').vehicle.charging?.settings?.targetStateOfChargeInPercent);
		});
	}

	describe('Der Baum spiegelt die Antwort', () => {
		it('verwendet fuer alle statischen mehrsprachigen Namen genau die elf ioBroker-Sprachen', async () => {
			await writer.write(VIN, fixture('synth-idle'));
			await writer.writeCommandResult(VIN, { name: 'charging.start', result: 'SENT', timestamp: clock });

			for (const [id, object] of adapter.objects) {
				const name = object.common?.name;
				if (name === undefined) {
					continue;
				}
				if (typeof name === 'string') {
					continue;
				}
				expect(Object.keys(name).sort(), id).to.deep.equal([...OBJECT_NAME_LANGUAGES].sort());
				for (const language of OBJECT_NAME_LANGUAGES) {
					expect(name[language]?.trim(), `${id} (${language})`).to.not.be.empty;
				}
			}
		});

		it('laesst externe und unbekannte dynamische Namen als einfache Strings stehen', async () => {
			const response = fixture('idle');
			(response.vehicle as Record<string, unknown>).futureApiField = 'raw API value';
			await writer.write(VIN, response);

			expect(adapter.objects.get(VIN)?.common?.name).to.equal('Enyaq');
			expect(adapter.objects.get(`${VIN}.chargingProfiles.profiles.1`)?.common?.name).to.equal('Zu Hause');
			expect(adapter.objects.get(`${VIN}.futureApiField`)?.common?.name).to.equal('futureApiField');
		});

		for (const name of ['idle', 'plugged', 'charging', 'climatising', 'synth-idle']) {
			it(`bildet jedes Feld der Aufnahme "${name}" auf einen Zustand ab`, async () => {
				const response = fixture(name);
				await writer.write(VIN, response);

				const vehicle = response.vehicle as unknown as Record<string, unknown>;
				for (const [leafPath, value] of leaves(vehicle)) {
					// Die Ladeprofile bekommen eine eigene Form (E16) und werden
					// weiter unten gesondert geprueft.
					if (leafPath.startsWith('chargingProfiles.profiles')) {
						continue;
					}
					const id = `${VIN}.${leafPath}`;
					expect(adapter.objects.has(id), `Zustand fehlt: ${leafPath}`).to.equal(true);
					const displayed =
						typeof value === 'number'
							? leafPath.endsWith('remainingCruisingRangeInMeters')
								? value / 1000
								: leafPath.endsWith('durationInSeconds')
									? value / 60
									: value
							: value;
					expect(adapter.val(id), `Wert weicht ab: ${leafPath}`).to.equal(displayed);
				}
			});
		}

		it('erzeugt fuer die echte Aufnahme genau diesen Baum', async () => {
			// Der Snapshot des erwarteten Objektbaums. Er steht bewusst
			// ausgeschrieben da: Wer den Writer aendert, sieht in der Abweichung
			// sofort, welche Objekte dazukommen oder verschwinden - und dass
			// Objekte verschwinden, ist bei einem Adapter, der nie loescht, immer
			// eine Entscheidung und kein Detail.
			await writer.write(VIN, fixture('idle'));

			const baum = [...adapter.objects.entries()]
				.map(([id, obj]) => `${obj.type} ${id === VIN ? '' : id.slice(VIN.length + 1)}`)
				.sort();

			expect(baum).to.deep.equal([
				'channel airConditioning',
				'channel airConditioning.targetTemperature',
				'channel airConditioning.windowHeating',
				'channel charging',
				'channel charging.settings',
				'channel charging.status',
				'channel charging.status.battery',
				'channel chargingProfiles',
				'channel chargingProfiles.profiles',
				'channel chargingProfiles.profiles.1',
				'channel info',
				'channel odometer',
				'channel parkingPosition',
				'channel parkingPosition.gpsCoordinates',
				'channel status',
				'channel status.detail',
				'channel status.overall',
				'device ',
				'state airConditioning.airConditioningAtUnlock',
				'state airConditioning.carCapturedTimestamp',
				'state airConditioning.enabled',
				'state airConditioning.start',
				'state airConditioning.state',
				'state airConditioning.stop',
				'state airConditioning.targetTemperature.unit',
				'state airConditioning.targetTemperature.value',
				'state airConditioning.windowHeating.enabled',
				'state airConditioning.windowHeating.front',
				'state airConditioning.windowHeating.rear',
				'state charging.carCapturedTimestamp',
				'state charging.enabled',
				'state charging.isVehicleInSavedLocation',
				'state charging.settings.autoUnlockPlugWhenCharged',
				'state charging.settings.availableChargeModes',
				'state charging.settings.batteryCareModeTargetValueInPercent',
				'state charging.settings.chargingCareMode',
				'state charging.settings.maxChargeCurrentAc',
				'state charging.settings.preferredChargeMode',
				'state charging.settings.targetStateOfChargeInPercent',
				'state charging.start',
				'state charging.status.battery.remainingCruisingRangeInMeters',
				'state charging.status.battery.stateOfChargeInPercent',
				'state charging.status.chargePowerInKw',
				'state charging.status.fullyChargedAt',
				'state charging.status.remainingTimeToFullyChargedInMinutes',
				'state charging.status.state',
				'state charging.stop',
				'state chargingProfiles.carCapturedTimestamp',
				'state chargingProfiles.profiles.1.configurationJson',
				'state chargingProfiles.profiles.1.name',
				'state chargingProfiles.profiles.1.preferredChargingTimesJson',
				'state chargingProfiles.profiles.1.settingsJson',
				'state chargingProfiles.profiles.1.targetStateOfChargeInPercent',
				'state chargingProfiles.profiles.1.timersJson',
				'state info.dataAge',
				'state info.lastErrors',
				'state licensePlate',
				'state name',
				'state odometer.carCapturedTimestamp',
				'state odometer.mileageInKm',
				'state parkingPosition.formattedAddress',
				'state parkingPosition.gpsCoordinates.latitude',
				'state parkingPosition.gpsCoordinates.longitude',
				'state parkingPosition.position',
				'state parkingPosition.state',
				'state renderUrl',
				'state status.carCapturedTimestamp',
				'state status.detail.bonnet',
				'state status.detail.sunroof',
				'state status.detail.trunk',
				'state status.overall.doors',
				'state status.overall.doorsLocked',
				'state status.overall.lights',
				'state status.overall.locked',
				'state status.overall.reliableLockStatus',
				'state status.overall.windows',
				'state vin',
			]);
		});

		it('legt keinen Zustand fuer einen Teil an, den das Fahrzeug nicht liefert', async () => {
			await writer.write(VIN, fixture('idle'));
			// Der Enyaq ist ein BEV ohne Standheizung und ohne aktive Belueftung.
			const ids = adapter.stateIds.join('\n');
			expect(ids).to.not.contain('fuelStatus');
			expect(ids).to.not.contain('auxiliaryHeating');
			expect(ids).to.not.contain('activeVentilation');
		});

		it('legt den Geraeteknoten mit dem Fahrzeugnamen an', async () => {
			await writer.write(VIN, fixture('idle'));
			const device = adapter.objects.get(VIN);
			expect(device?.type).to.equal('device');
			expect(device?.common?.name).to.equal('Enyaq');
		});

		it('uebernimmt Rollen und Einheiten aus Generat und Overlay', async () => {
			await writer.write(VIN, fixture('idle'));
			const soc = adapter.objects.get(`${VIN}.charging.status.battery.stateOfChargeInPercent`);
			expect(soc?.common).to.include({ type: 'number', role: 'value.battery', unit: '%' });
			expect(adapter.objects.get(`${VIN}.odometer.mileageInKm`)?.common).to.include({ unit: 'km' });
		});

		it('holt die Temperatureinheit aus dem Geschwisterfeld, nicht aus der Spec', async () => {
			// Die Spec kennt nur "value" und "unit" - welche Skala gilt, steht erst in
			// den Daten.
			await writer.write(VIN, fixture('idle'));
			expect(adapter.objects.get(`${VIN}.airConditioning.targetTemperature.value`)?.common).to.include({
				unit: '°C',
			});
		});

		it('legt die Position zusaetzlich als lat;lon an', async () => {
			await writer.write(VIN, fixture('idle'));
			const id = `${VIN}.parkingPosition.position`;
			expect(adapter.objects.get(id)?.common).to.include({ role: 'value.gps' });
			expect(adapter.val(id)).to.equal('47.3769;8.5417');
		});
	});

	describe('Lesbare Einheiten und bestehende Objekte', () => {
		const response: VehicleResponse = {
			vehicle: {
				charging: {
					isVehicleInSavedLocation: false,
					status: { battery: { remainingCruisingRangeInMeters: 300500 } },
				},
				activeVentilation: { state: 'OFF', durationInSeconds: 600 },
				auxiliaryHeating: { state: 'OFF', durationInSeconds: 90 },
			},
		};
		const cases = [
			{
				path: 'charging.status.battery.remainingCruisingRangeInMeters',
				raw: 300500,
				val: 300.5,
				oldUnit: 'm',
				unit: 'km',
			},
			{ path: 'activeVentilation.durationInSeconds', raw: 600, val: 10, oldUnit: 's', unit: 'min' },
			{ path: 'auxiliaryHeating.durationInSeconds', raw: 90, val: 1.5, oldUnit: 's', unit: 'min' },
		];
		for (const item of cases) {
			it(`rechnet ${item.path} um und migriert vorhandene Metadaten`, async () => {
				const id = `${VIN}.${item.path}`;
				await adapter.setObjectNotExistsAsync(id, {
					type: 'state',
					common: {
						name: generatedStateDefs[item.path].desc!,
						type: 'number',
						role: 'value',
						read: true,
						write: false,
						unit: item.oldUnit,
					},
					native: { retained: true },
				});
				await adapter.setStateAsync(id, { val: item.raw, ack: true, q: 1 });
				await writer.write(VIN, structuredClone(response));
				expect(adapter.states.get(id)).to.include({ val: item.val, q: 0 });
				expect(adapter.objects.get(id)?.common).to.include({ unit: item.unit });
				expect(adapter.objects.get(id)?.common?.name).not.to.equal(generatedStateDefs[item.path].desc);
				expect(adapter.objects.get(id)?.native).to.deep.equal({ retained: true });
				writer = new StateWriter({ api: adapter });
				adapter.writes.length = 0;
				await writer.write(VIN, structuredClone(response));
				expect(adapter.val(id)).to.equal(item.val);
				expect(adapter.writes).not.to.contain(id);
			});
		}
		it('behaelt eigene Beschriftungen und laesst die API-Antwort unveraendert', async () => {
			const id = `${VIN}.${cases[0].path}`;
			await adapter.setObjectNotExistsAsync(id, {
				type: 'state',
				common: {
					name: 'Meine Reichweite',
					type: 'number',
					role: 'value.distance',
					read: true,
					write: false,
					unit: 'm',
				},
				native: {},
			});
			const raw = structuredClone(response);
			await writer.write(VIN, raw);
			expect(raw).to.deep.equal(response);
			expect(adapter.objects.get(id)?.common?.name).to.equal('Meine Reichweite');
		});

		it('migriert bisherige englische Standardnamen auf vollstaendige Metadaten', async () => {
			const path = 'charging.status.battery.stateOfChargeInPercent';
			const id = `${VIN}.${path}`;
			await adapter.setObjectNotExistsAsync(id, {
				type: 'state',
				common: {
					name: generatedStateDefs[path].desc!,
					type: 'number',
					role: 'value.battery',
					read: true,
					write: false,
				},
				native: {},
			});
			await writer.write(VIN, {
				vehicle: {
					charging: { isVehicleInSavedLocation: false, status: { battery: { stateOfChargeInPercent: 80 } } },
				},
			});
			const name = adapter.objects.get(id)?.common?.name as ioBroker.Translated;
			expect(name).to.include({ en: 'State of charge', de: 'Ladestand', ru: 'Уровень заряда' });
			expect(Object.keys(name).sort()).to.deep.equal([...OBJECT_NAME_LANGUAGES].sort());
		});

		it('migriert bisherige unvollstaendige Uebersetzungsobjekte, aber keine Benutzertexte', async () => {
			const path = 'charging.status.battery.stateOfChargeInPercent';
			const id = `${VIN}.${path}`;
			await adapter.setObjectNotExistsAsync(id, {
				type: 'state',
				common: {
					name: { en: 'State of charge', de: 'Ladestand' },
					type: 'number',
					role: 'value.battery',
					read: true,
					write: false,
				},
				native: {},
			});
			await writer.write(VIN, {
				vehicle: {
					charging: { isVehicleInSavedLocation: false, status: { battery: { stateOfChargeInPercent: 80 } } },
				},
			});
			expect(Object.keys(adapter.objects.get(id)?.common?.name as object).sort()).to.deep.equal(
				[...OBJECT_NAME_LANGUAGES].sort(),
			);

			const customized = new FakeAdapter();
			await customized.setObjectNotExistsAsync(id, {
				type: 'state',
				common: {
					name: { en: 'My charge', de: 'Mein Ladestand' },
					type: 'number',
					role: 'value.battery',
					read: true,
					write: false,
				},
				native: {},
			});
			await new StateWriter({ api: customized }).write(VIN, {
				vehicle: {
					charging: { isVehicleInSavedLocation: false, status: { battery: { stateOfChargeInPercent: 80 } } },
				},
			});
			expect(customized.objects.get(id)?.common?.name).to.deep.equal({ en: 'My charge', de: 'Mein Ladestand' });
		});

		it('korrigiert die Rolle eines bestehenden String-States ohne Wertverlust', async () => {
			const path = 'status.detail.bonnet';
			const id = `${VIN}.${path}`;
			await adapter.setObjectNotExistsAsync(id, {
				type: 'state',
				common: {
					name: 'Bonnet',
					type: 'string',
					role: 'sensor.door',
					read: true,
					write: false,
					states: { OPEN: 'Open', CLOSED: 'Closed', UNKNOWN: 'Unknown' },
				},
				native: { retained: true },
			});
			await adapter.setStateAsync(id, { val: 'CLOSED', ack: true });

			await writer.write(VIN, fixture('idle'));

			expect(adapter.objects.get(id)?.common).to.include({
				type: 'string',
				role: 'text',
				read: true,
				write: false,
			});
			expect(adapter.objects.get(id)?.native).to.deep.equal({ retained: true });
			expect((adapter.objects.get(id)?.common as ioBroker.StateCommon).states).to.deep.equal({
				OPEN: 'Open',
				CLOSED: 'Closed',
				UNKNOWN: 'Unknown',
			});
			expect(adapter.val(id)).to.equal('CLOSED');
		});
	});

	describe('URL-Rolle', () => {
		for (const previousRole of [undefined, 'url', 'custom.role']) {
			it(`verwendet text.url und migriert nur die alte Adapter-Rolle (${previousRole})`, async () => {
				const id = `${VIN}.renderUrl`;
				const url = 'https://example.com/car.png';
				if (previousRole !== undefined) {
					await adapter.setObjectNotExistsAsync(id, {
						type: 'state',
						common: { name: 'My image', type: 'string', role: previousRole, read: true, write: false },
						native: { retained: true },
					});
				}
				await writer.write(VIN, { vehicle: { renderUrl: url } });
				expect(adapter.objects.get(id)?.common?.role).to.equal(
					previousRole === 'custom.role' ? previousRole : 'text.url',
				);
				expect(adapter.val(id)).to.equal(url);
				if (previousRole !== undefined) {
					expect(adapter.objects.get(id)?.common?.name).to.equal('My image');
					expect(adapter.objects.get(id)?.native).to.deep.equal({ retained: true });
				}
			});
		}
	});

	describe('Ladeprofile', () => {
		it('ueberspringt ungueltige IDs ohne Pfadkollisionen und schreibt gueltige Profile weiter', async () => {
			const response = fixture('idle');
			const profiles = response.vehicle.chargingProfiles!.profiles;
			const template = profiles[0];
			const validIds = [1, 0, -2, 'home_1-A', 'a_b'];
			const invalidIds = [
				'a.b',
				'a b',
				'',
				'a/b',
				'a\\b',
				'a*b',
				'a_b\n',
				1.5,
				NaN,
				Infinity,
				-Infinity,
				null,
				undefined,
				true,
				{},
			];
			// Exercise malformed runtime responses beyond the generated API type.
			response.vehicle.chargingProfiles!.profiles = [...invalidIds, ...validIds].map(id => ({
				...template,
				id,
				name: typeof id === 'number' || typeof id === 'string' ? `Profile ${id}` : 'Invalid',
			})) as typeof profiles;

			await writer.write(VIN, response);

			const prefix = `${VIN}.chargingProfiles.profiles.`;
			const profileChannels = [...adapter.objects.entries()]
				.filter(([id, object]) => id.startsWith(prefix) && object.type === 'channel')
				.map(([id]) => id);
			expect(profileChannels).to.have.members(validIds.map(id => `${prefix}${id}`));
			for (const id of validIds) {
				expect(adapter.val(`${prefix}${id}.name`)).to.equal(`Profile ${id}`);
			}
			expect(adapter.warnings).to.have.length(invalidIds.length);
			for (const warning of adapter.warnings) {
				expect(warning).to.equal('Skipping charging profile with an invalid ID.');
			}
		});

		it('haengt sie an die Profil-ID, nicht an den Index', async () => {
			await writer.write(VIN, fixture('idle'));
			expect(adapter.val(`${VIN}.chargingProfiles.profiles.1.name`)).to.equal('Zu Hause');
			expect(adapter.val(`${VIN}.chargingProfiles.profiles.1.targetStateOfChargeInPercent`)).to.equal(80);
			expect(adapter.objects.has(`${VIN}.chargingProfiles.profiles.0.name`)).to.equal(false);
		});

		it('legt alles unterhalb der Profilebene als JSON ab', async () => {
			await writer.write(VIN, fixture('idle'));
			const timers = JSON.parse(String(adapter.val(`${VIN}.chargingProfiles.profiles.1.timersJson`)));
			expect(timers).to.be.an('array').with.length(3);
			const settings = JSON.parse(String(adapter.val(`${VIN}.chargingProfiles.profiles.1.settingsJson`)));
			// Ohne settingsJson waere maxChargingCurrent nicht sichtbar - genau der
			// Wert, an dem das Ueberschussladen haengt.
			expect(settings.maxChargingCurrent).to.equal('REDUCED');
			expect(adapter.objects.get(`${VIN}.chargingProfiles.profiles.1.timersJson`)?.common).to.include({
				role: 'json',
			});
		});

		it('legt eine gewoehnliche Liste als JSON-Zustand ab', async () => {
			await writer.write(VIN, fixture('idle'));
			expect(adapter.val(`${VIN}.charging.settings.availableChargeModes`)).to.equal('["MANUAL"]');
		});
	});

	describe('Befehls-States aus der Faehigkeitserkennung', () => {
		it('legt nur an, was das Fahrzeug liefert', async () => {
			await writer.write(VIN, fixture('idle'));
			expect(adapter.objects.has(`${VIN}.charging.enabled`)).to.equal(true);
			expect(adapter.objects.has(`${VIN}.charging.start`)).to.equal(true);
			expect(adapter.objects.has(`${VIN}.charging.stop`)).to.equal(true);
			expect(adapter.objects.has(`${VIN}.airConditioning.enabled`)).to.equal(true);
			// Standheizung und aktive Belueftung liefert dieser Enyaq nicht.
			expect(adapter.objects.has(`${VIN}.auxiliaryHeating.enabled`)).to.equal(false);
			expect(adapter.objects.has(`${VIN}.activeVentilation.enabled`)).to.equal(false);
		});

		it('legt sie fuer ein Fahrzeug mit vollem Funktionsumfang an', async () => {
			await writer.write(VIN, fixture('synth-idle'));
			expect(adapter.objects.has(`${VIN}.activeVentilation.enabled`)).to.equal(true);
		});

		it('macht aus dem Schalter einen Soll-Zustand mit Schreibrecht', async () => {
			await writer.write(VIN, fixture('idle'));
			expect(adapter.objects.get(`${VIN}.charging.enabled`)?.common).to.include({
				role: 'switch',
				read: true,
				write: true,
			});
			expect(adapter.objects.get(`${VIN}.charging.start`)?.common).to.include({
				role: 'button',
				read: false,
				write: true,
			});
		});

		it('bildet den Ist-Zustand ab: true genau beim Laden', async () => {
			await writer.write(VIN, fixture('idle'));
			expect(adapter.val(`${VIN}.charging.enabled`)).to.equal(false);

			const laden = new FakeAdapter();
			await new StateWriter({ api: laden, now: () => clock }).write(VIN, fixture('charging'));
			expect(laden.val(`${VIN}.charging.enabled`)).to.equal(true);
		});

		it('zaehlt eine laufende Klimatisierung als eingeschaltet', async () => {
			await writer.write(VIN, fixture('climatising'));
			expect(adapter.val(`${VIN}.airConditioning.enabled`)).to.equal(true);
		});
	});

	describe('info', () => {
		it('rechnet dataAge aus dem juengsten Zeitstempel', async () => {
			await writer.write(VIN, fixture('idle'));
			// Juengster carCapturedTimestamp der Aufnahme: 18:12:49.301Z.
			expect(adapter.val(`${VIN}.info.dataAge`)).to.equal(131);
			expect(adapter.objects.get(`${VIN}.info.dataAge`)?.common).to.include({ unit: 's' });
		});

		it('schreibt lastErrors auch dann, wenn nichts fehlt', async () => {
			await writer.write(VIN, fixture('idle'));
			expect(adapter.val(`${VIN}.info.lastErrors`)).to.equal('[]');
		});

		it('legt die gemeldeten Fehler als JSON ab', async () => {
			const response = fixture('idle');
			response.errors = [{ type: 'CHARGING_UNAVAILABLE', description: 'nicht erreichbar' }];
			await writer.write(VIN, response);
			expect(JSON.parse(String(adapter.val(`${VIN}.info.lastErrors`)))).to.deep.equal(response.errors);
		});
	});

	it('does not mark a restored refresh button as missing vehicle data', async () => {
		await adapter.setStateAsync(`${VIN}.refresh`, { val: false, ack: true, q: 0 });
		await writer.write(VIN, fixture('idle'));
		expect((await adapter.getStateAsync(`${VIN}.refresh`))?.q).to.equal(0);
	});

	describe('Unvollstaendige Antworten', () => {
		it('markiert vorhandene States auch bei einem Fehler im ersten Poll nach Neustart', async () => {
			await writer.write(VIN, fixture('charging'));
			writer = new StateWriter({ api: adapter });
			await writer.write(VIN, { vehicle: {}, errors: [{ type: 'CHARGING_UNAVAILABLE' }] });
			expect(adapter.states.get(`${VIN}.charging.status.state`)).to.include({
				val: 'CHARGING',
				q: QUALITY_NOT_GOOD,
			});
		});

		it('hebt gespeicherte schlechte Qualitaet nach Neustart auch bei gleichem Wert auf', async () => {
			await writer.write(VIN, fixture('charging'));
			await writer.write(VIN, { vehicle: {}, errors: [{ type: 'CHARGING_UNAVAILABLE' }] });
			writer = new StateWriter({ api: adapter });
			await writer.write(VIN, fixture('charging'));
			expect(adapter.quality(`${VIN}.charging.status.state`)).to.equal(0);
		});

		it('markiert verschwundene Einzelwerte und geloeschte Profile, ohne sie zu loeschen', async () => {
			await writer.write(VIN, fixture('charging'));
			const next = fixture('charging');
			delete next.vehicle.charging!.status!.chargePowerInKw;
			next.vehicle.chargingProfiles!.profiles = [];
			await writer.write(VIN, next);
			expect(adapter.states.get(`${VIN}.charging.status.chargePowerInKw`)).to.include({
				val: 5,
				q: QUALITY_NOT_GOOD,
			});
			expect(adapter.quality(`${VIN}.chargingProfiles.profiles.1.name`)).to.equal(QUALITY_NOT_GOOD);
			expect(adapter.quality(`${VIN}.charging.status.state`)).to.equal(0);
			await writer.write(VIN, fixture('charging'));
			expect(adapter.quality(`${VIN}.charging.status.chargePowerInKw`)).to.equal(0);
		});

		it('markiert absichtlich nicht gelieferte Teile ohne Fehler nicht als ausgefallen', async () => {
			await writer.write(VIN, fixture('idle'));
			writer = new StateWriter({ api: adapter });
			await writer.write(VIN, { vehicle: { name: 'Enyaq' } });
			expect(adapter.quality(`${VIN}.parkingPosition.position`)).to.equal(0);
		});
		it('laesst den letzten Wert stehen und markiert ihn als nicht gut', async () => {
			await writer.write(VIN, fixture('idle'));
			const id = `${VIN}.charging.status.battery.stateOfChargeInPercent`;
			expect(adapter.val(id)).to.equal(73);

			const unvollstaendig = fixture('idle');
			delete (unvollstaendig.vehicle as Record<string, unknown>).charging;
			unvollstaendig.errors = [{ type: 'CHARGING_UNAVAILABLE', description: 'nicht erreichbar' }];
			await writer.write(VIN, unvollstaendig);

			// Kein null, kein Loeschen: Der Wert bleibt, die Qualitaet sinkt (E8).
			expect(adapter.val(id)).to.equal(73);
			expect(adapter.quality(id)).to.equal(QUALITY_NOT_GOOD);
		});

		it('hebt die Markierung auf, sobald der Teil zurueckkommt - auch bei gleichem Wert', async () => {
			const id = `${VIN}.charging.status.battery.stateOfChargeInPercent`;
			await writer.write(VIN, fixture('idle'));

			const unvollstaendig = fixture('idle');
			delete (unvollstaendig.vehicle as Record<string, unknown>).charging;
			unvollstaendig.errors = [{ type: 'CHARGING_UNAVAILABLE', description: 'nicht erreichbar' }];
			await writer.write(VIN, unvollstaendig);
			expect(adapter.quality(id)).to.equal(QUALITY_NOT_GOOD);

			// Derselbe Wert wie vorher: setStateChanged allein wuerde nicht schreiben
			// und die Markierung stehen lassen.
			await writer.write(VIN, fixture('idle'));
			expect(adapter.quality(id)).to.equal(0);
			expect(adapter.val(id)).to.equal(73);
		});

		it('markiert nur die gemeldeten Teile', async () => {
			await writer.write(VIN, fixture('idle'));
			const unvollstaendig = fixture('idle');
			delete (unvollstaendig.vehicle as Record<string, unknown>).charging;
			unvollstaendig.errors = [{ type: 'CHARGING_UNAVAILABLE', description: 'nicht erreichbar' }];
			await writer.write(VIN, unvollstaendig);

			expect(adapter.quality(`${VIN}.odometer.mileageInKm`)).to.equal(0);
		});
	});

	describe('Zweiter Durchlauf', () => {
		it('schreibt bei unveraenderten Daten keinen einzigen Zustand', async () => {
			await writer.write(VIN, fixture('idle'));
			const objectsAfterFirst = adapter.objects.size;
			adapter.writes.length = 0;

			await writer.write(VIN, fixture('idle'));

			expect(adapter.writes, `unerwartet geschrieben: ${adapter.writes.join(', ')}`).to.have.length(0);
			expect(adapter.objects.size).to.equal(objectsAfterFirst);
		});

		it('schreibt genau die Zustaende, die sich geaendert haben', async () => {
			await writer.write(VIN, fixture('idle'));
			adapter.writes.length = 0;

			const bewegt = fixture('idle');
			(bewegt.vehicle.odometer as Record<string, unknown>).mileageInKm = 30070;
			await writer.write(VIN, bewegt);

			expect(adapter.writes).to.deep.equal([`${VIN}.odometer.mileageInKm`]);
		});
	});

	describe('Ergebnis eines Befehls', () => {
		it('schreibt es nach info.lastCommand', async () => {
			await writer.write(VIN, fixture('idle'));
			await writer.writeCommandResult(VIN, {
				name: 'charging.start',
				result: 'SENT',
				timestamp: clock,
				acknowledge: { path: 'charging.enabled', value: true },
			});

			expect(adapter.val(`${VIN}.info.lastCommand.name`)).to.equal('charging.start');
			expect(adapter.val(`${VIN}.info.lastCommand.result`)).to.equal('SENT');
			expect(adapter.val(`${VIN}.info.lastCommand.timestamp`)).to.equal(clock);
			const common = adapter.objects.get(`${VIN}.info.lastCommand.result`)?.common as ioBroker.StateCommon;
			expect(common.states).to.include({ SENT: 'Handed over to the API' });
		});

		it('quittiert den ausloesenden Zustand, obwohl sein Wert derselbe bleibt', async () => {
			await writer.write(VIN, fixture('idle'));
			// Der Nutzer hat true geschrieben, mit ack: false. setStateChanged wuerde
			// bei gleichem Wert gar nicht schreiben - die Quittung bliebe aus.
			await adapter.setStateAsync(`${VIN}.charging.enabled`, { val: true, ack: false });
			adapter.writes.length = 0;

			await writer.writeCommandResult(VIN, {
				name: 'charging.start',
				result: 'SENT',
				timestamp: clock,
				acknowledge: { path: 'charging.enabled', value: true },
			});

			expect(adapter.writes).to.contain(`${VIN}.charging.enabled`);
			expect(adapter.states.get(`${VIN}.charging.enabled`)).to.include({ val: true, ack: true });
		});

		it('kommt auch vor dem ersten Poll zurecht', async () => {
			await writer.writeCommandResult(VIN, { name: 'charging.stop', result: 'EXPIRED', timestamp: clock });
			expect(adapter.objects.get(VIN)?.type).to.equal('device');
			expect(adapter.val(`${VIN}.info.lastCommand.result`)).to.equal('EXPIRED');
			expect(adapter.val(`${VIN}.info.lastCommand.problemType`)).to.equal('');
		});
	});

	describe('Unbekannte Pfade', () => {
		it('legt sie mit geratenem Typ an und warnt genau einmal', async () => {
			const response = fixture('idle');
			(response.vehicle.odometer as Record<string, unknown>).tyrePressureInBar = 2.4;

			await writer.write(VIN, response);
			await writer.write(VIN, response);

			const id = `${VIN}.odometer.tyrePressureInBar`;
			expect(adapter.objects.get(id)?.common).to.include({ type: 'number', role: 'state' });
			expect(adapter.val(id)).to.equal(2.4);
			expect(adapter.warnings).to.have.length(1);
			expect(adapter.warnings[0]).to.contain('tyrePressureInBar');
			// Die Warnung landet im Log und das Log im Forum: keine VIN darin (E14).
			expect(adapter.warnings[0]).to.not.contain(VIN);
		});
	});
});
