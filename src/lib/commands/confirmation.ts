/** Confirmation describes observed vehicle data, not the API's command acceptance. */
export const CONFIRMATION_STATUSES = {
	WAITING: 'Waiting for matching, newer vehicle data',
	CONFIRMED: 'Matching, newer vehicle data observed',
	TIMED_OUT: 'No confirmation observed before the deadline',
	INTERRUPTED: 'Confirmation tracking interrupted by adapter restart',
} as const;

export type ConfirmationStatus = keyof typeof CONFIRMATION_STATUSES;

/** Latest accepted command for one independent vehicle control. */
export interface CommandConfirmation {
	/** Stable control path, e.g. charging, chargingLimit or chargingProfiles.1. */
	channel: string;
	/** Original command name, including start/stop. */
	name: string;
	/** JSON target: Boolean, number, string or a complete charging profile. */
	target: string;
	/** API acceptance time in Unix milliseconds. */
	sentAt: number;
	/** Local deadline in Unix milliseconds. */
	expiresAt: number;
	/** Local observation time in Unix milliseconds; zero until confirmed. */
	confirmedAt: number;
	/** Observation outcome, independent of info.lastCommand.result. */
	status: ConfirmationStatus;
}
