/** Stable state values for scripts and readable labels for the object browser. */
export const POLLING_REASONS = {
	STARTUP: 'Initial poll scheduled',
	POLLING: 'Vehicle request in progress',
	IDLE_INTERVAL: 'Waiting for the normal polling interval',
	ACTIVE_INTERVAL: 'Waiting for the active vehicle interval',
	COMMAND_INTERVAL: 'Waiting for the interval after a command',
	UNCHANGED_DATA: 'Longer interval because vehicle timestamps are unchanged',
	VERIFICATION: 'Verification poll scheduled after a command',
	MANUAL_REFRESH: 'Manual refresh scheduled',
	COMMAND_RESERVE: 'Remaining requests reserved for commands',
	QUOTA: 'Waiting for API quota',
	STARTUP_GUARD: 'Waiting to protect quota after restart',
	AUTH_ERROR: 'Waiting after API key rejection',
	ERROR_RETRY: 'Waiting to retry a failed request',
	ERROR_INTERVAL: 'Waiting for the regular interval after a failed request',
	WRITE_RETRY: 'Retrying local state writes without another API request',
	SUSPENDED: 'Polling suspended because the vehicle was not found',
} as const;

export type PollingReason = keyof typeof POLLING_REASONS;

/** Scheduler diagnostics; timestamps use milliseconds since Unix epoch. */
export interface PollingStatus {
	/** Planned next request attempt; zero when running, suspended or retrying local writes. */
	nextPollAt: number;
	/** Last successful API response, including partial responses; undefined before first success this run. */
	lastSuccessfulPollAt?: number;
	/** Reason for the current scheduler state, independent of data freshness. */
	reason: PollingReason;
}
