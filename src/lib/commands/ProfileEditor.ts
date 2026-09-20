/** Local charging-profile drafts. Only an explicit apply enters the existing command queue. */
import { diagnosticText, EDITOR_MESSAGES } from '../diagnosticTranslations';
import { vehicleErrors } from '../api/client';
import { partFromErrorType } from '../api/parts';
import type { VehicleResponse } from '../api/types';
import { EDITOR_LABELS, EDITOR_CHOICES, EDITOR_DESCRIPTIONS, weekdayLabel } from './profileEditorLabels';
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
	private readonly metadata = new Map<string, ioBroker.StateCommon>();
	private readonly values = new Map<string, ioBroker.StateValue>();
	private chain: Promise<void> = Promise.resolve();

	/**
	 * @param api Local ioBroker state storage.
	 * @param submit Existing command queue, with the original snapshot for conflict detection.
	 * @param language System language for selection labels (common.states requires strings).
	 */
	public constructor(
		private readonly api: StateApi,
		private readonly submit: (id: string, value: string, base: string) => Promise<void>,
		private readonly language: string = 'en',
	) {}

	/**
	 * Disable persisted controls until a fresh poll establishes their availability.
	 *
	 * @param vins Configured vehicle IDs.
	 */
	public initialize(vins: readonly string[]): Promise<void> {
		return this.serial(async () => {
			for (const vin of vins) {
				const prefix = `${vin}.${ROOT}.`;
				const states = await this.api.getStatesAsync(`${prefix}*`);
				const roots = new Set<string>();
				for (const [fullId, state] of Object.entries(states)) {
					const start = fullId.indexOf(prefix);
					if (start < 0 || !state) {
						continue;
					}
					const id = fullId.slice(start);
					const match = /^-?\d+\.edit\./.exec(id.slice(prefix.length));
					if (!match) {
						continue;
					}
					const root = id.slice(0, id.indexOf('.edit.') + 5);
					roots.add(root);
					const object = await this.api.getObjectAsync(id);
					if (object?.type === 'state') {
						this.metadata.set(id, object.common);
						this.values.set(id, state.val);
					}
				}
				for (const root of roots) {
					await this.disableUnused(root, new Set());
					await this.availability(root, false);
					await this.state(
						`${root}.message`,
						diagnosticText('unavailable', EDITOR_MESSAGES.unavailable, this.language),
						{
							name: translated('Profile editor message', 'Meldung der Profilbearbeitung'),
							type: 'string',
							role: 'text',
							read: true,
							write: false,
						},
					);
				}
			}
		});
	}

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
					draft.message = diagnosticText('unavailable', EDITOR_MESSAGES.unavailable, this.language);
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
				const common = this.metadata.get(id);
				if (common && !['dirty', 'conflict', 'message', 'available'].includes(path)) {
					await this.state(id, this.values.get(id) ?? null, common, 1);
				}
				return;
			} // No persisted draft is ever submitted before a fresh poll.
			if (path === 'apply' || path === 'reset') {
				await this.api.setStateAsync(id, { val: false, ack: true, q: draft.current ? 0 : 1 });
				if (value !== true) {
					return;
				}
				if (!draft.current) {
					draft.message = diagnosticText('unavailable', EDITOR_MESSAGES.unavailable, this.language);
				} else if (path === 'reset') {
					draft.base = draft.current;
					draft.value = JSON.parse(draft.current);
					draft.message = '';
				} else if (draft.base !== draft.current) {
					draft.message = diagnosticText('conflict', EDITOR_MESSAGES.conflict, this.language);
				} else if (!isChargingProfile(draft.value)) {
					draft.message = diagnosticText('invalid', EDITOR_MESSAGES.invalid, this.language);
				} else if (canonicalJson(draft.value) === draft.base) {
					draft.message = diagnosticText('unchanged', EDITOR_MESSAGES.unchanged, this.language);
				} else {
					await this.submit(
						`${root.slice(0, -'.edit'.length)}.configurationJson`,
						canonicalJson(draft.value),
						draft.base,
					);
					draft.message = diagnosticText('submitted', EDITOR_MESSAGES.submitted, this.language);
				}
			} else {
				const field =
					draft.current && fields(JSON.parse(draft.current)).some(field => field.path === path)
						? fields(draft.value).find(field => field.path === path)
						: undefined;
				if (!field) {
					await this.write(root, draft);
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
					draft.message = diagnosticText('invalidField', EDITOR_MESSAGES.invalidField, this.language).replace(
						'%s',
						() => path,
					);
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
		const available = new Set(draft.current ? fields(JSON.parse(draft.current)).map(field => field.path) : []);
		const active = new Set<string>();
		for (const field of fields(draft.value)) {
			const parts = field.path.split('.');
			for (let i = 1; i < parts.length; i++) {
				await this.channel(
					`${root}.${parts.slice(0, i).join('.')}`,
					EDITOR_LABELS[parts[i - 1] as keyof typeof EDITOR_LABELS] ??
						localizedObjectName(parts[i - 1], parts[i - 1]),
				);
			}
			await this.state(
				`${root}.${field.path}`,
				field.value,
				{
					name:
						weekdayLabel(parts.at(-1)!) ??
						EDITOR_LABELS[parts.at(-1)! as keyof typeof EDITOR_LABELS] ??
						localizedObjectName(field.path, field.path),
					desc: !available.has(field.path)
						? EDITOR_DESCRIPTIONS.unavailable
						: /(?:^|\.)(?:time|startTime|endTime)$/.test(field.path)
							? EDITOR_DESCRIPTIONS.time
							: EDITOR_DESCRIPTIONS.field,
					type: typeof field.value as 'string' | 'number' | 'boolean',
					role:
						typeof field.value === 'boolean'
							? field.path.includes('.recurringOn.')
								? 'switch'
								: 'switch.setting'
							: typeof field.value === 'number'
								? field.path.includes('minimumBattery')
									? 'level.setting.battery.min'
									: 'level.setting.battery'
								: 'text',
					read: true,
					write: available.has(field.path),
					...(field.states
						? {
								states: Object.fromEntries(
									field.states.map(value => {
										const names =
											weekdayLabel(value) ?? EDITOR_CHOICES[value as keyof typeof EDITOR_CHOICES];
										return [
											value,
											names?.[this.language as keyof typeof names] ?? names?.en ?? value,
										];
									}),
								),
							}
						: {}),
					...(field.percent ? { unit: '%', min: 0, max: 100, step: 1 } : {}),
				},
				available.has(field.path) ? 0 : 1,
			);
			if (available.has(field.path)) {
				active.add(`${root}.${field.path}`);
			}
		}
		for (const button of ['apply', 'reset'] as const) {
			await this.state(
				`${root}.${button}`,
				false,
				{
					name:
						button === 'apply'
							? translated('Apply profile changes', 'Profiländerungen übernehmen')
							: translated('Reset profile draft', 'Profilentwurf zurücksetzen'),
					desc: draft.current ? EDITOR_DESCRIPTIONS[button] : EDITOR_DESCRIPTIONS.unavailable,
					type: 'boolean',
					role: 'button',
					read: false,
					write: draft.current !== undefined,
				},
				draft.current ? 0 : 1,
			);
			if (draft.current) {
				active.add(`${root}.${button}`);
			}
		}
		await this.disableUnused(root, active);
		await this.availability(root, draft.current !== undefined);
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
			const existing = await this.api.getObjectAsync(id);
			await this.api.setObjectNotExistsAsync(id, { type: 'channel', common: { name }, native: {} });
			if (existing && existing.common.name === id.split('.').at(-1)) {
				await this.api.extendObjectAsync(id, { common: { name } });
			}
			this.created.add(id);
		}
	}

	/**
	 * Keep obsolete controls visible but read-only and flagged as unavailable.
	 *
	 * @param root Profile editor path.
	 * @param active State IDs supported by the latest response.
	 */
	private async disableUnused(root: string, active: Set<string>): Promise<void> {
		for (const [id, common] of this.metadata) {
			if (
				!id.startsWith(`${root}.`) ||
				active.has(id) ||
				['dirty', 'conflict', 'message', 'available'].includes(id.slice(root.length + 1))
			) {
				continue;
			}
			await this.state(
				id,
				this.values.get(id) ?? null,
				{ ...common, write: false, desc: EDITOR_DESCRIPTIONS.unavailable },
				1,
			);
		}
	}

	/**
	 * Expose profile availability independently of draft conflicts.
	 *
	 * @param root Profile editor path.
	 * @param available Whether current polled data contains a valid profile.
	 */
	private async availability(root: string, available: boolean): Promise<void> {
		await this.state(`${root}.available`, available, {
			name: EDITOR_LABELS.available,
			type: 'boolean',
			role: 'indicator',
			read: true,
			write: false,
		});
	}

	/**
	 * Migrate owned metadata while retaining custom names and other user settings.
	 *
	 * @param id Relative state ID.
	 * @param val Local value.
	 * @param common Field metadata.
	 * @param quality Zero for available data, one for unavailable retained values.
	 */
	private async state(
		id: string,
		val: ioBroker.StateValue,
		common: ioBroker.StateCommon,
		quality: 0 | 1 = 0,
	): Promise<void> {
		if (quality === 1) {
			common = {
				...common,
				read: true,
				write: false,
				role: common.type === 'boolean' ? 'indicator' : common.type === 'number' ? 'value' : 'text',
			};
		}
		let previous = this.metadata.get(id);
		if (!previous) {
			const existing = await this.api.getObjectAsync(id);
			if (existing?.type === 'state') {
				previous = existing.common;
			} else {
				await this.api.setObjectNotExistsAsync(id, { type: 'state', common, native: {} });
			}
		}
		if (previous) {
			const legacyName = id.slice(id.indexOf('.edit.') + 6);
			if (previous.name !== legacyName) {
				common = { ...common, name: previous.name };
			}
			const patch = Object.fromEntries(
				Object.entries(common).filter(
					([key, value]) =>
						canonicalJson(previous[key as keyof ioBroker.StateCommon]) !== canonicalJson(value),
				),
			);
			if (Object.keys(patch).length) {
				await this.api.extendObjectAsync(id, { common: patch });
			}
		}
		this.metadata.set(id, { ...previous, ...common });
		this.values.set(id, val);
		const state = await this.api.getStateAsync(id);
		if ((state?.q ?? 0) !== quality) {
			await this.api.setStateAsync(id, { val, ack: true, q: quality });
		} else {
			await this.api.setStateChangedAsync(id, { val, ack: true, q: quality });
		}
	}
}
