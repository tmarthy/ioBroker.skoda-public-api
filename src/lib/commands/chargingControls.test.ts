import { expect } from 'chai';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { canonicalJson, isChargingProfile } from './chargingControls';
import { buildCommandBody, parseCommandState } from './commandMap';

const VIN = 'TMBJB9NY5RF999999';
const profile = (): any =>
	JSON.parse(readFileSync(join(__dirname, '../../../test/fixtures/vehicle-idle.json'), 'utf8')).body.vehicle
		.chargingProfiles.profiles[0];

describe('complete charging profile validation', () => {
	it('round-trips the real profile including optional and unknown fields', () => {
		const value = profile();
		value.futureField = { enabled: true };
		const command = parseCommandState(
			`${VIN}.chargingProfiles.profiles.1.configurationJson`,
			JSON.stringify(value),
		)!;
		expect(buildCommandBody(command, { block: { profiles: [value] } })).to.deep.equal({ body: value });
		expect(canonicalJson({ b: 1, a: { y: 2, x: 3 } })).to.equal(canonicalJson({ a: { x: 3, y: 2 }, b: 1 }));
	});

	const invalid: Array<[string, (p: any) => void]> = [
		[
			'missing settings',
			p => {
				delete p.settings;
			},
		],
		[
			'missing timers',
			p => {
				delete p.timers;
			},
		],
		[
			'missing times',
			p => {
				delete p.preferredChargingTimes;
			},
		],
		[
			'unsafe ID',
			p => {
				p.id = Number.MAX_SAFE_INTEGER + 1;
			},
		],
		[
			'string ID',
			p => {
				p.id = '1';
			},
		],
		[
			'wrong name type',
			p => {
				p.name = 4;
			},
		],
		[
			'invalid current',
			p => {
				p.settings.maxChargingCurrent = 'MEDIUM';
			},
		],
		[
			'invalid percentage',
			p => {
				p.settings.targetStateOfChargeInPercent = 101;
			},
		],
		[
			'fractional minimum',
			p => {
				p.settings.minBatteryStateOfCharge.minimumBatteryStateOfChargeInPercent = 10.5;
			},
		],
		[
			'wrong enabled type',
			p => {
				p.timers[0].enabled = 'false';
			},
		],
		[
			'invalid time',
			p => {
				p.timers[0].time = '24:00';
			},
		],
		[
			'invalid preferred time',
			p => {
				p.preferredChargingTimes[0].startTime = '1:00';
			},
		],
		[
			'duplicate timer IDs',
			p => {
				p.timers.push(p.timers[0]);
			},
		],
		[
			'duplicate charging time IDs',
			p => {
				p.preferredChargingTimes.push(p.preferredChargingTimes[0]);
			},
		],
		[
			'invalid day',
			p => {
				p.timers[0].recurringOn = ['FUNDAY'];
			},
		],
		[
			'missing active timer time',
			p => {
				p.timers[0].enabled = true;
				delete p.timers[0].time;
			},
		],
		[
			'missing active one-off day',
			p => {
				p.timers[0].enabled = true;
				p.timers[0].type = 'ONE_OFF';
			},
		],
		[
			'array timer type',
			p => {
				p.timers[0].type = ['RECURRING'];
			},
		],
	];
	for (const [label, mutate] of invalid) {
		it(`rejects ${label}`, () => {
			const value = profile();
			mutate(value);
			expect(isChargingProfile(value)).to.equal(false);
		});
	}

	it('rejects ID mismatches and incomplete JSON bodies', () => {
		for (const value of ['{', 'null', '[]', '{}', 42, JSON.stringify({ ...profile(), id: 2 })]) {
			const command = parseCommandState(`${VIN}.chargingProfiles.profiles.1.configurationJson`, value)!;
			expect(buildCommandBody(command, { block: { profiles: [profile()] } }).problem).to.be.a('string');
		}
		for (const id of ['1.0', '01', '1e0', 'unsafe', '9007199254740992']) {
			expect(parseCommandState(`${VIN}.chargingProfiles.profiles.${id}.configurationJson`, '{}')).to.equal(
				undefined,
			);
		}
	});
});
