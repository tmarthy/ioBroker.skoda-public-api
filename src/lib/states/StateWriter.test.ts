import { expect } from 'chai';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { FakeAdapter } from '../../../test/helpers/fakeAdapter';
import type { VehicleResponse } from '../api/types';
import { QUALITY_NOT_GOOD, StateWriter, type StateApi } from './StateWriter';
import { generatedStateDefs } from './objectDefs.generated';

/**
 * Beweist zur Uebersetzungszeit, dass eine echte Adapter-Instanz die schmale
 * Schnittstelle erfuellt - sonst faellt das erst in Phase 6 bei der Verdrahtung auf.
 */
type AdapterErfuelltStateApi = ioBroker.Adapter extends StateApi ? true : false;

const FIXTURE_DIR = path.join(__dirname, '..', '..', '..', 'test', 'fixtures');
const VIN = 'TMBJB9NY5RF999999';

/**
 * Laedt eine Aufnahme aus Phase 2.
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

	describe('Der Baum spiegelt die Antwort', () => {
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
			// Der Snapshot aus dem Abnahmekriterium der Phase. Er steht bewusst
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

		it('migriert bisherige englische Standardnamen auf zweisprachige Metadaten', async () => {
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
			expect(adapter.objects.get(id)?.common?.name).to.deep.equal({ en: 'State of charge', de: 'Ladestand' });
		});
	});

	describe('Ladeprofile', () => {
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
