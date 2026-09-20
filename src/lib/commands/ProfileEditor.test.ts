import { expect } from 'chai';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { FakeAdapter } from '../../../test/helpers/fakeAdapter';
import type { VehicleResponse } from '../api/types';
import { ProfileEditor } from './ProfileEditor';
import { OBJECT_NAME_LANGUAGES } from '../i18n';
import { canonicalJson } from './chargingControls';

const VIN = 'TMBJB9NY5RF999999';
const ROOT = `${VIN}.chargingProfiles.profiles.1.edit`;
const fixture = (): VehicleResponse =>
	JSON.parse(readFileSync(path.join(__dirname, '../../../test/fixtures/vehicle-charging.json'), 'utf8')).body;

describe('commands/ProfileEditor => local drafts and explicit apply', () => {
	let api: FakeAdapter;
	let editor: ProfileEditor;
	let submitted: Array<{ id: string; value: string; base: string }>;
	beforeEach(async () => {
		api = new FakeAdapter();
		submitted = [];
		editor = new ProfileEditor(api, (id, value, base) => {
			submitted.push({ id, value, base });
			return Promise.resolve();
		});
		await editor.observe(VIN, fixture());
	});
	const edit = (field: string, value: unknown): Promise<void> => editor.handle(`${ROOT}.${field}`, value);

	it('stages multiple fields and submits exactly one complete profile, preserving unknown fields', async () => {
		const response = fixture();
		const profile = response.vehicle.chargingProfiles!.profiles[0];
		Object.assign(profile, { futureApiField: { keep: true } });
		await editor.observe(VIN, response);
		await edit('name', 'Work');
		await edit('settings.targetStateOfChargeInPercent', 90);
		await edit('timers.1.time', '08:15');
		await edit('timers.1.recurringOn.SATURDAY', true);
		await edit('preferredChargingTimes.1.enabled', true);
		expect(submitted).to.have.length(0);
		expect(api.val(`${ROOT}.dirty`)).to.equal(true);
		await edit('apply', true);
		expect(submitted).to.have.length(1);
		const actual = JSON.parse(submitted[0].value);
		expect(actual).to.include({ id: 1, name: 'Work' });
		expect(actual.futureApiField).to.deep.equal({ keep: true });
		expect(actual.settings.targetStateOfChargeInPercent).to.equal(90);
		expect(actual.timers[0].time).to.equal('08:15');
		expect(actual.timers[0].recurringOn).to.include('SATURDAY');
		expect(actual.preferredChargingTimes[0].enabled).to.equal(true);
		expect(submitted[0].base).to.equal(canonicalJson(profile));
		expect(api.val(`${ROOT}.apply`)).to.equal(false);
	});

	it('preserves edits across polls, blocks conflicting changes and resets locally', async () => {
		await edit('name', 'Draft');
		await editor.observe(VIN, fixture());
		expect(api.val(`${ROOT}.name`)).to.equal('Draft');
		const changed = fixture();
		changed.vehicle.chargingProfiles!.profiles[0].settings.targetStateOfChargeInPercent = 70;
		await editor.observe(VIN, changed);
		expect(api.val(`${ROOT}.conflict`)).to.equal(true);
		await edit('apply', true);
		expect(submitted).to.have.length(0);
		expect(api.val(`${ROOT}.message`)).to.include('changed during editing');
		await edit('reset', true);
		expect(api.val(`${ROOT}.name`)).to.equal('Zu Hause');
		expect(api.val(`${ROOT}.settings.targetStateOfChargeInPercent`)).to.equal(70);
		expect(api.val(`${ROOT}.dirty`)).to.equal(false);
		expect(api.val(`${ROOT}.conflict`)).to.equal(false);
	});

	it('rejects bad values without changing the draft and validates timer combinations on apply', async () => {
		for (const [field, value] of [
			['settings.targetStateOfChargeInPercent', 101],
			['settings.targetStateOfChargeInPercent', '90'],
			['timers.1.time', '25:00'],
			['timers.1.enabled', 'true'],
			['settings.maxChargingCurrent', 'INVALID'],
		] as const) {
			await edit(field, value);
			expect(api.val(`${ROOT}.message`)).to.include('Invalid value');
		}
		expect(api.val(`${ROOT}.dirty`)).to.equal(false);
		await edit('timers.1.type', 'ONE_OFF');
		await edit('timers.1.enabled', true);
		await edit('apply', true);
		expect(submitted).to.have.length(0);
		await edit('timers.1.oneOffDay', 'SUNDAY');
		await edit('apply', true);
		expect(submitted).to.have.length(1);
	});

	it('ignores forged IDs, unchanged apply, and non-boolean button presses', async () => {
		await edit('apply', true);
		await edit('id', 2);
		await edit('timers.999.time', '08:00');
		await editor.handle(`${VIN}.chargingProfiles.profiles.999.edit.apply`, true);
		await edit('name', 'Draft');
		await edit('apply', 'true');
		await edit('apply', false);
		expect(submitted).to.have.length(0);
	});

	it('cannot send missing profiles and never restores persisted drafts after restart', async () => {
		await edit('name', 'Draft');
		const missing = fixture();
		delete missing.vehicle.chargingProfiles;
		await editor.observe(VIN, missing);
		await edit('apply', true);
		expect(submitted).to.have.length(0);
		expect(api.val(`${ROOT}.conflict`)).to.equal(true);
		editor = new ProfileEditor(api, (id, value, base) => {
			submitted.push({ id, value, base });
			return Promise.resolve();
		});
		await edit('apply', true);
		expect(submitted).to.have.length(0);
		await editor.observe(VIN, fixture());
		expect(api.val(`${ROOT}.name`)).to.equal('Zu Hause');
		expect(api.val(`${ROOT}.dirty`)).to.equal(false);
	});

	it('clears dirty after matching data and keeps different profiles and vehicles independent', async () => {
		await edit('name', 'Updated');
		const response = fixture();
		response.vehicle.chargingProfiles!.profiles[0].name = 'Updated';
		await editor.observe(VIN, response);
		expect(api.val(`${ROOT}.dirty`)).to.equal(false);
		await editor.observe('OTHER_VIN', fixture());
		await edit('name', 'Only this VIN');
		expect(api.val(`OTHER_VIN.chargingProfiles.profiles.1.edit.name`)).to.equal('Zu Hause');
	});

	it('serializes rapid edits before apply and uses timer IDs rather than array indexes', async () => {
		const response = fixture();
		response.vehicle.chargingProfiles!.profiles[0].timers.reverse();
		await editor.observe(VIN, response);
		await Promise.all([edit('name', 'Serial'), edit('timers.1.time', '10:30'), edit('apply', true)]);
		expect(submitted).to.have.length(1);
		const profile = JSON.parse(submitted[0].value);
		expect(profile.name).to.equal('Serial');
		expect(profile.timers.find((timer: { id: number }) => timer.id === 1).time).to.equal('10:30');
		expect(profile.timers[0].id).to.equal(3);
	});
	it('uses setting roles, translated field names and localized choices with help text', async () => {
		editor = new ProfileEditor(api, () => Promise.resolve(), 'de');
		await editor.initialize([VIN]);
		await editor.observe(VIN, fixture());
		const common = (field: string): ioBroker.StateCommon =>
			api.objects.get(`${ROOT}.${field}`)!.common as ioBroker.StateCommon;
		expect(common('timers.1.enabled').role).to.equal('switch.setting');
		expect(common('settings.targetStateOfChargeInPercent').role).to.equal('level.setting.battery');
		expect(common('settings.minBatteryStateOfCharge.minimumBatteryStateOfChargeInPercent').role).to.equal(
			'level.setting.battery.min',
		);
		expect(common('name').role).to.equal('text');
		expect(common('timers.1.time').role).to.equal('text');
		expect(common('apply')).to.include({ role: 'button', read: false, write: true });
		expect(common('timers.1.time').name).to.have.property('de', 'Abfahrtszeit');
		expect(common('timers.1.time').desc).to.have.property('de').that.includes('Fahrzeug-Ortszeit');
		expect(common('timers.1.type').states).to.deep.equal({ ONE_OFF: 'Einmalig', RECURRING: 'Wiederkehrend' });
		expect(common('timers.1.oneOffDay').states).to.have.property('MONDAY', 'Montag');
		expect(common('timers.1.recurringOn.MONDAY').name).to.have.property('de', 'Montag');
		for (const [id, object] of api.objects) {
			if (id.startsWith(`${ROOT}.`) && object.type === 'state') {
				expect(Object.keys(object.common.name)).to.have.members([...OBJECT_NAME_LANGUAGES]);
			}
		}
	});

	it('disables removed fields, preserves their values, rejects writes, and reactivates returning fields', async () => {
		const response = fixture();
		response.vehicle.chargingProfiles!.profiles[0].timers = [];
		delete response.vehicle.chargingProfiles!.profiles[0].settings.maxChargingCurrent;
		await editor.observe(VIN, response);
		const id = `${ROOT}.timers.1.time`;
		expect(api.objects.get(id)!.common).to.have.property('write', false);
		expect(api.objects.get(id)!.common)
			.to.have.property('desc')
			.that.has.property('de')
			.that.includes('nicht verfügbar');
		expect(api.val(id)).to.equal('07:00');
		expect(api.quality(id)).to.equal(1);
		await api.setStateAsync(id, { val: '12:00', ack: false });
		await edit('timers.1.time', '12:00');
		expect(api.val(id)).to.equal('07:00');
		expect(api.val(`${ROOT}.available`)).to.equal(true);
		expect(submitted).to.have.length(0);
		await editor.observe(VIN, fixture());
		expect(api.objects.get(id)!.common).to.have.property('write', true);
		expect(api.quality(id)).to.equal(0);
		expect(api.objects.get(id)!.common)
			.to.have.property('desc')
			.that.has.property('de')
			.that.includes('Fahrzeug-Ortszeit');
	});

	it('retains dirty drafts but disables fields removed by a conflicting poll', async () => {
		await edit('timers.1.time', '08:00');
		const response = fixture();
		response.vehicle.chargingProfiles!.profiles[0].timers = [];
		await editor.observe(VIN, response);
		expect(api.val(`${ROOT}.timers.1.time`)).to.equal('08:00');
		expect(api.val(`${ROOT}.dirty`)).to.equal(true);
		expect(api.val(`${ROOT}.conflict`)).to.equal(true);
		expect(api.objects.get(`${ROOT}.timers.1.time`)!.common).to.have.property('write', false);
		await edit('apply', true);
		expect(submitted).to.have.length(0);
	});

	it('disables persisted controls before the first poll and retains deleted profiles across restart', async () => {
		editor = new ProfileEditor(api, () => Promise.resolve());
		await editor.initialize([VIN]);
		expect(api.val(`${ROOT}.available`)).to.equal(false);
		expect(api.objects.get(`${ROOT}.apply`)!.common).to.have.property('write', false);
		expect(api.quality(`${ROOT}.name`)).to.equal(1);
		await api.setStateAsync(`${ROOT}.name`, { val: 'Premature edit', ack: false });
		await edit('name', 'Premature edit');
		expect(api.val(`${ROOT}.name`)).to.equal('Zu Hause');
		const response = fixture();
		response.vehicle.chargingProfiles!.profiles = [];
		await editor.observe(VIN, response);
		expect(api.objects.get(`${ROOT}.name`)!.common).to.have.property('write', false);
		expect(api.val(`${ROOT}.name`)).to.equal('Zu Hause');
		await editor.observe(VIN, fixture());
		expect(api.val(`${ROOT}.available`)).to.equal(true);
		expect(api.objects.get(`${ROOT}.apply`)!.common).to.have.property('write', true);
		expect(api.quality(`${ROOT}.name`)).to.equal(0);
	});

	it('migrates legacy defaults while preserving custom names and unrelated metadata', async () => {
		const id = `${ROOT}.timers.1.time`;
		await api.extendObjectAsync(id, {
			common: { name: 'timers.1.time', role: 'text', custom: { 'history.0': { enabled: true } } },
		});
		await api.extendObjectAsync(`${ROOT}.name`, { common: { name: 'Mein Profilname' } });
		editor = new ProfileEditor(api, () => Promise.resolve());
		await editor.initialize([VIN]);
		await editor.observe(VIN, fixture());
		expect(api.objects.get(id)!.common!.name).to.have.property('de', 'Abfahrtszeit');
		expect(api.objects.get(id)!.common).to.have.property('role', 'text');
		expect(api.objects.get(id)!.common)
			.to.have.property('custom')
			.that.deep.equals({ 'history.0': { enabled: true } });
		expect(api.objects.get(`${ROOT}.name`)!.common!.name).to.equal('Mein Profilname');
		await api.extendObjectAsync(id, { common: { name: 'Meine Abfahrtszeit' } });
		const response = fixture();
		response.vehicle.chargingProfiles!.profiles[0].timers = [];
		await editor.observe(VIN, response);
		expect(api.objects.get(id)!.common!.name).to.equal('Meine Abfahrtszeit');
	});
	it('keeps detailed roles unique per channel and makes unavailable roles consistent with access rights', async () => {
		const check = (): void => {
			const used = new Set<string>();
			for (const [id, object] of api.objects) {
				if (object.type !== 'state') {
					continue;
				}
				const common = object.common;
				if (common.role.includes('.')) {
					const key = `${id.slice(0, id.lastIndexOf('.'))}|${common.role}`;
					expect(used.has(key), key).to.equal(false);
					used.add(key);
				}
				if (common.role === 'button') {
					expect(common).to.include({ read: false, write: true, type: 'boolean' });
				}
				if (/^(switch|level)(\.|$)/.test(common.role)) {
					expect(common.write, id).to.equal(true);
				}
				if (/^(indicator|value)(\.|$)/.test(common.role)) {
					expect(common).to.include({ read: true, write: false });
				}
			}
		};
		check();
		const missing = fixture();
		delete missing.vehicle.chargingProfiles;
		await editor.observe(VIN, missing);
		check();
		expect(api.objects.get(`${ROOT}.apply`)!.common).to.include({ read: true, write: false, role: 'indicator' });
		await edit('apply', false);
		expect(api.quality(`${ROOT}.apply`)).to.equal(1);
		await editor.observe(VIN, fixture());
		check();
		expect(api.objects.get(`${ROOT}.apply`)!.common).to.include({ read: false, write: true, role: 'button' });
		editor = new ProfileEditor(api, () => Promise.resolve());
		await editor.initialize([VIN]);
		check();
	});

	it('localizes visible validation and submission messages without translating API values', async () => {
		editor = new ProfileEditor(api, () => Promise.resolve(), 'de');
		await api.setStateAsync(`${ROOT}.message`, { val: 'Old English message', ack: true });
		await editor.initialize([VIN]);
		expect(api.val(`${ROOT}.message`)).to.equal(
			'Profil derzeit nicht verfügbar. Auf gültige Fahrzeugdaten warten.',
		);
		await editor.observe(VIN, fixture());
		await edit('timers.1.time', '25:00');
		expect(api.val(`${ROOT}.message`)).to.equal('Ungültiger Wert für timers.1.time.');
		await edit('apply', true);
		expect(api.val(`${ROOT}.message`)).to.equal('Keine Änderungen zum Übernehmen.');
		await edit('name', 'Arbeit');
		await edit('apply', true);
		expect(api.val(`${ROOT}.message`)).to.include('An Befehlswarteschlange übergeben');
		expect(api.val(`${ROOT}.timers.1.type`)).to.equal('RECURRING');
	});
});
