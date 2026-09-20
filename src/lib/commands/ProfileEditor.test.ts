import { expect } from 'chai';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { FakeAdapter } from '../../../test/helpers/fakeAdapter';
import type { VehicleResponse } from '../api/types';
import { ProfileEditor } from './ProfileEditor';
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
});
