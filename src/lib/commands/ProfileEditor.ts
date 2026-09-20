/** Local charging-profile drafts. Only an explicit apply enters the existing command queue. */
import { vehicleErrors } from '../api/client';
import { partFromErrorType } from '../api/parts';
import type { VehicleResponse } from '../api/types';
import { translated } from '../i18n';
import { localizedObjectName } from '../states/objectNames';
import type { StateApi } from '../states/StateWriter';
import { canonicalJson, isChargingProfile, isRecord } from './chargingControls';

type Profile = Record<string, unknown>;
interface Draft {
	base: string;
	value: Profile;
	current?: string;
	message: string;
}
interface Field {
	path: string;
	value: string | number | boolean;
	states?: string[];
	percent?: boolean;
}
const DAYS = ['MONDAY', 'TUESDAY', 'WEDNESDAY', 'THURSDAY', 'FRIDAY', 'SATURDAY', 'SUNDAY'];
const ROOT = 'chargingProfiles.profiles';

/**
 * Expose supported fields; IDs and unknown API fields are retained but never editable.
 *
 * @param profile Complete profile snapshot.
 */
function fields(profile: Profile): Field[] {
	const result: Field[] = [{ path: 'name', value: profile.name as string }];
	const add = (object: Profile, key: string, prefix: string, states?: string[]): void => {
		const value = object[key];
		if (typeof value === 'string' || typeof value === 'boolean' || typeof value === 'number') {
			result.push({ path: `${prefix}${key}`, value, states, percent: key.endsWith('InPercent') });
		}
	};
	const settings = profile.settings as Profile;
	add(settings, 'targetStateOfChargeInPercent', 'settings.');
	add(settings, 'maxChargingCurrent', 'settings.', ['REDUCED', 'MAXIMUM']);
	add(settings, 'autoUnlockPlugWhenCharged', 'settings.', ['PERMANENT', 'OFF']);
	if (isRecord(settings.minBatteryStateOfCharge)) {
		add(settings.minBatteryStateOfCharge, 'enabled', 'settings.minBatteryStateOfCharge.');
		add(
			settings.minBatteryStateOfCharge,
			'minimumBatteryStateOfChargeInPercent',
			'settings.minBatteryStateOfCharge.',
		);
	}
	for (const group of ['timers', 'preferredChargingTimes']) {
		for (const entry of profile[group] as Profile[]) {
			const prefix = `${group}.${String(entry.id)}.`;
			add(entry, 'enabled', prefix);
			if (group === 'timers') {
				add(entry, 'type', prefix, ['ONE_OFF', 'RECURRING']);
				result.push({ path: `${prefix}time`, value: (entry.time as string | undefined) ?? '' });
				result.push({
					path: `${prefix}oneOffDay`,
					value: (entry.oneOffDay as string | undefined) ?? '',
					states: ['', ...DAYS],
				});
				for (const day of DAYS) {
					result.push({
						path: `${prefix}recurringOn.${day}`,
						value: Array.isArray(entry.recurringOn) && entry.recurringOn.includes(day),
					});
				}
			} else {
				add(entry, 'startTime', prefix);
				add(entry, 'endTime', prefix);
			}
		}
	}
	return result;
}

/**
 * Set a whitelisted field by stable entry ID, never by array position.
 *
 * @param profile Mutable draft.
 * @param path Validated field path.
 * @param value Validated primitive value.
 */
function setField(profile: Profile, path: string, value: unknown): void {
	const parts = path.split('.');
	let target = profile;
	if (parts[0] === 'timers' || parts[0] === 'preferredChargingTimes') {
		target = (profile[parts.shift()!] as Profile[]).find(entry => String(entry.id) === parts[0])!;
		parts.shift();
		if (parts.at(0) === 'recurringOn') {
			const selected = new Set((target.recurringOn as string[] | undefined) ?? []);
			if (value) {
				selected.add(parts[1]);
			} else {
				selected.delete(parts[1]);
			}
			target.recurringOn = DAYS.filter(day => selected.has(day));
			return;
		}
	}
	while (parts.length > 1) {
		target = target[parts.shift()!] as Profile;
	}
	const key = parts[0];
	if ((key === 'oneOffDay' || key === 'time') && value === '') {
		delete target[key];
	} else {
		target[key] = value;
	}
}

/** Serializes local edits and polls so a poll cannot overwrite a half-written draft. */
export class ProfileEditor {
	private readonly drafts = new Map<string, Draft>();
	private readonly created = new Set<string>();
	private chain: Promise<void> = Promise.resolve();

	/**
	 * @param api Local ioBroker state storage.
	 * @param submit Existing command queue, with the original snapshot for conflict detection.
	 */
	public constructor(
		private readonly api: StateApi,
		private readonly submit: (id: string, value: string, base: string) => Promise<void>,
	) {}

	/**
	 * Update drafts from an already scheduled poll; never fetches data itself.
	 *
	 * @param vin Vehicle identification number.
	 * @param response Existing poll response.
	 */
	public observe(vin: string, response: VehicleResponse): Promise<void> {
		return this.serial(async () => {
			const block = (response.vehicle as unknown as Profile).chargingProfiles;
			const failed = vehicleErrors(response).some(error => partFromErrorType(error.type) === 'chargingProfiles');
			const profiles = !failed && isRecord(block) && Array.isArray(block.profiles) ? block.profiles : [];
			const seen = new Set<string>();
			for (const profile of profiles) {
				if (!isChargingProfile(profile)) {
					continue;
				}
				const root = `${vin}.${ROOT}.${profile.id}.edit`;
				seen.add(root);
				const current = canonicalJson(profile);
				let draft = this.drafts.get(root);
				if (!draft || canonicalJson(draft.value) === draft.base || canonicalJson(draft.value) === current) {
					draft = { base: current, value: JSON.parse(current), current, message: '' };
					this.drafts.set(root, draft);
				} else {
					draft.current = current;
				}
				await this.write(root, draft);
			}
			for (const [root, draft] of this.drafts) {
				if (root.startsWith(`${vin}.`) && !seen.has(root)) {
					draft.current = undefined;
					draft.message = 'Profile unavailable in the latest poll. Wait for valid vehicle data.';
					await this.write(root, draft);
				}
			}
		});
	}

	/**
	 * Stage a local field or explicitly apply/reset the draft.
	 *
	 * @param id Relative ioBroker state ID.
	 * @param value User-written value (ack=false).
	 */
	public handle(id: string, value: unknown): Promise<void> {
		return this.serial(async () => {
			const split = id.indexOf('.edit.');
			if (split < 0) {
				return;
			}
			const root = id.slice(0, split + '.edit'.length);
			const path = id.slice(root.length + 1);
			const draft = this.drafts.get(root);
			if (!draft) {
				return;
			} // No persisted draft is ever submitted before a fresh poll.
			if (path === 'apply' || path === 'reset') {
				await this.api.setStateAsync(id, { val: false, ack: true });
				if (value !== true) {
					return;
				}
				if (!draft.current) {
					draft.message = 'Profile unavailable in the latest poll. Wait for valid vehicle data.';
				} else if (path === 'reset') {
					draft.base = draft.current;
					draft.value = JSON.parse(draft.current);
					draft.message = '';
				} else if (draft.base !== draft.current) {
					draft.message = 'Profile changed during editing. Reset the draft and reapply your changes.';
				} else if (!isChargingProfile(draft.value)) {
					draft.message = 'Invalid profile. Check timer time, type and selected days before applying.';
				} else if (canonicalJson(draft.value) === draft.base) {
					draft.message = 'No changes to apply.';
				} else {
					await this.submit(
						`${root.slice(0, -'.edit'.length)}.configurationJson`,
						canonicalJson(draft.value),
						draft.base,
					);
					draft.message = 'Submitted to command queue. See info.lastCommand and info.commandConfirmation.';
				}
			} else {
				const field = fields(draft.value).find(field => field.path === path);
				if (!field) {
					return;
				}
				const valid =
					typeof value === typeof field.value &&
					(!field.states || field.states.includes(value as string)) &&
					(!field.percent ||
						(Number.isInteger(value) && (value as number) >= 0 && (value as number) <= 100)) &&
					(!/(?:^|\.)(?:time|startTime|endTime)$/.test(path) ||
						(value === '' && path.endsWith('.time')) ||
						/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(String(value)));
				if (!valid) {
					draft.message = `Invalid value for ${path}.`;
				} else {
					setField(draft.value, path, value);
					draft.message = '';
				}
			}
			await this.write(root, draft);
		});
	}

	/**
	 * Recover the serialization chain after a storage error.
	 *
	 * @param action Local operation.
	 */
	private serial(action: () => Promise<void>): Promise<void> {
		const task = this.chain.catch(() => undefined).then(action);
		this.chain = task;
		return task;
	}

	/**
	 * Write draft fields and local diagnostics; never overwrite the polled profile states.
	 *
	 * @param root Edit channel.
	 * @param draft Local draft and latest reported snapshot.
	 */
	private async write(root: string, draft: Draft): Promise<void> {
		await this.channel(root, translated('Edit charging profile', 'Ladeprofil bearbeiten'));
		for (const field of fields(draft.value)) {
			const parts = field.path.split('.');
			for (let i = 1; i < parts.length; i++) {
				await this.channel(
					`${root}.${parts.slice(0, i).join('.')}`,
					localizedObjectName(parts[i - 1], parts[i - 1]),
				);
			}
			await this.state(`${root}.${field.path}`, field.value, {
				name: localizedObjectName(field.path, field.path),
				type: typeof field.value as 'string' | 'number' | 'boolean',
				role: typeof field.value === 'boolean' ? 'switch' : typeof field.value === 'number' ? 'level' : 'text',
				read: true,
				write: true,
				...(field.states
					? { states: Object.fromEntries(field.states.map(value => [value, value || '—'])) }
					: {}),
				...(field.percent ? { unit: '%', min: 0, max: 100, step: 1 } : {}),
			});
		}
		for (const button of ['apply', 'reset'] as const) {
			await this.state(`${root}.${button}`, false, {
				name:
					button === 'apply'
						? translated('Apply profile changes', 'Profiländerungen übernehmen')
						: translated('Reset profile draft', 'Profilentwurf zurücksetzen'),
				type: 'boolean',
				role: 'button',
				read: false,
				write: true,
			});
		}
		await this.state(`${root}.dirty`, canonicalJson(draft.value) !== draft.base, {
			name: translated('Profile draft changed', 'Profilentwurf geändert'),
			type: 'boolean',
			role: 'indicator',
			read: true,
			write: false,
		});
		await this.state(`${root}.conflict`, draft.current === undefined || draft.current !== draft.base, {
			name: translated('Profile draft conflict', 'Konflikt im Profilentwurf'),
			type: 'boolean',
			role: 'indicator',
			read: true,
			write: false,
		});
		await this.state(`${root}.message`, draft.message, {
			name: translated('Profile editor message', 'Meldung der Profilbearbeitung'),
			type: 'string',
			role: 'text',
			read: true,
			write: false,
		});
	}

	/**
	 * Create a channel once per process.
	 *
	 * @param id Relative channel ID.
	 * @param name Display name.
	 */
	private async channel(id: string, name: ioBroker.StringOrTranslated): Promise<void> {
		if (!this.created.has(id)) {
			await this.api.setObjectNotExistsAsync(id, { type: 'channel', common: { name }, native: {} });
			this.created.add(id);
		}
	}

	/**
	 * Create a field and acknowledge local staging, not vehicle execution.
	 *
	 * @param id Relative state ID.
	 * @param val Local value.
	 * @param common Field metadata.
	 */
	private async state(id: string, val: ioBroker.StateValue, common: ioBroker.StateCommon): Promise<void> {
		if (!this.created.has(id)) {
			await this.api.setObjectNotExistsAsync(id, { type: 'state', common, native: {} });
			this.created.add(id);
		}
		await this.api.setStateChangedAsync(id, { val, ack: true, q: 0 });
	}
}
