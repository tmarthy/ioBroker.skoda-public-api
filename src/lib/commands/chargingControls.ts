/** Validation and stable JSON values for atomic charging-profile updates. */
import type { ChargingProfile } from '../api/types';

export const CHARGE_MODES = [
	'MANUAL',
	'TIMER',
	'TIMER_CHARGING_WITH_CLIMATISATION',
	'PREFERRED_CHARGING_TIMES',
	'ONLY_OWN_CURRENT',
	'IMMEDIATE_DISCHARGING',
	'HOME_STORAGE_CHARGING',
] as const;

const DAYS = ['MONDAY', 'TUESDAY', 'WEDNESDAY', 'THURSDAY', 'FRIDAY', 'SATURDAY', 'SUNDAY'];
const TIME = /^(?:[01]\d|2[0-3]):[0-5]\d$/;

/**
 * Object guard, excluding arrays and null.
 *
 * @param value Candidate value.
 */
export function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Canonical serialization makes equivalent JSON independent of object key order.
 *
 * @param value JSON-compatible value.
 */
export function canonicalJson(value: unknown): string {
	const sort = (item: unknown): unknown => {
		if (Array.isArray(item)) {
			return item.map(sort);
		}
		if (isRecord(item)) {
			return Object.fromEntries(
				Object.keys(item)
					.sort()
					.map(key => [key, sort(item[key])]),
			);
		}
		return item;
	};
	return JSON.stringify(sort(value));
}

/**
 * IDs must round-trip through JavaScript and the ioBroker object path exactly.
 *
 * @param value Candidate ID.
 */
export function isProfileId(value: unknown): value is number {
	return typeof value === 'number' && Number.isSafeInteger(value);
}

/**
 * Find an existing profile; never manufacture a new profile from a state write.
 *
 * @param block Last polled charging-profiles block.
 * @param id Profile ID.
 */
export function findProfile(
	block: Record<string, unknown> | undefined,
	id: number,
): Record<string, unknown> | undefined {
	return Array.isArray(block?.profiles)
		? block.profiles.find((profile: unknown) => isRecord(profile) && profile.id === id)
		: undefined;
}

/**
 * Validate a complete profile while retaining additional API fields unchanged.
 *
 * @param value Parsed profile JSON.
 */
export function isChargingProfile(value: unknown): value is ChargingProfile {
	if (
		!isRecord(value) ||
		!isProfileId(value.id) ||
		typeof value.name !== 'string' ||
		!isRecord(value.settings) ||
		!Array.isArray(value.preferredChargingTimes) ||
		!Array.isArray(value.timers)
	) {
		return false;
	}
	const settings = value.settings;
	const optionalEnum = (v: unknown, choices: readonly string[]): boolean =>
		v === undefined || (typeof v === 'string' && choices.includes(v));
	const percent = (v: unknown): boolean => typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= 100;
	if (
		!optionalEnum(settings.maxChargingCurrent, ['REDUCED', 'MAXIMUM']) ||
		!optionalEnum(settings.autoUnlockPlugWhenCharged, ['PERMANENT', 'OFF']) ||
		(settings.targetStateOfChargeInPercent !== undefined && !percent(settings.targetStateOfChargeInPercent))
	) {
		return false;
	}
	if (settings.minBatteryStateOfCharge !== undefined) {
		const min = settings.minBatteryStateOfCharge;
		if (
			!isRecord(min) ||
			(min.enabled !== undefined && typeof min.enabled !== 'boolean') ||
			(min.minimumBatteryStateOfChargeInPercent !== undefined &&
				!percent(min.minimumBatteryStateOfChargeInPercent))
		) {
			return false;
		}
	}
	const validEntries = (entries: unknown[], validate: (entry: Record<string, unknown>) => boolean): boolean => {
		const ids = new Set<number>();
		return entries.every(entry => {
			if (!isRecord(entry) || !isProfileId(entry.id) || ids.has(entry.id) || typeof entry.enabled !== 'boolean') {
				return false;
			}
			ids.add(entry.id);
			return validate(entry);
		});
	};
	return (
		validEntries(
			value.preferredChargingTimes,
			entry =>
				typeof entry.startTime === 'string' &&
				TIME.test(entry.startTime) &&
				typeof entry.endTime === 'string' &&
				TIME.test(entry.endTime),
		) &&
		validEntries(value.timers, entry => {
			if (
				typeof entry.type !== 'string' ||
				!['ONE_OFF', 'RECURRING'].includes(entry.type) ||
				(entry.time !== undefined && (typeof entry.time !== 'string' || !TIME.test(entry.time))) ||
				(entry.enabled && entry.time === undefined) ||
				!optionalEnum(entry.oneOffDay, DAYS)
			) {
				return false;
			}
			if (
				entry.recurringOn !== undefined &&
				(!Array.isArray(entry.recurringOn) ||
					!entry.recurringOn.every(day => typeof day === 'string' && DAYS.includes(day)) ||
					new Set(entry.recurringOn).size !== entry.recurringOn.length)
			) {
				return false;
			}
			return (
				!entry.enabled ||
				(entry.type === 'ONE_OFF'
					? entry.oneOffDay !== undefined
					: Array.isArray(entry.recurringOn) && entry.recurringOn.length > 0)
			);
		})
	);
}
