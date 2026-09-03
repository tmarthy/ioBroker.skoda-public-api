/**
 * Ablage des Quota-Zustands in `info.rateLimit.*`.
 *
 * Damit ueberlebt das Budget einen Neustart des Adapters. Ohne diese Ablage startet
 * jede Instanz mit der Annahme, sie habe 20 Requests frei - und eine Instanz in
 * Neustartschleife verbrennt genau so das ganze Stundenbudget in anderthalb Minuten.
 *
 * Die Zustaende sind nebenbei die einzige Stelle, an der ein Mensch nachsehen kann,
 * wie viel Budget noch da ist; sie sind deshalb ausdruecklich lesbar und nicht bloss
 * ein internes Ablagefach.
 */
import type { PersistedQuota, QuotaStore } from './QuotaManager';

/** Der Ausschnitt der Adapter-Schnittstelle, den die Ablage braucht. */
export interface QuotaStateApi {
	/** Legt ein Objekt an, sofern es noch keines gibt. */
	setObjectNotExistsAsync(id: string, obj: ioBroker.SettableObject): ioBroker.SetObjectPromise;
	/** Liest einen Zustand. */
	getStateAsync(id: string): ioBroker.GetStatePromise;
	/** Schreibt einen Zustand, sofern er sich geaendert hat. */
	setStateChangedAsync(id: string, state: ioBroker.SettableState): ioBroker.SetStateChangedPromise;
}

/** Kanal, unter dem die vier Zustaende liegen. */
export const QUOTA_CHANNEL = 'info.rateLimit';

/** Die vier Zustaende und ihr `common`. */
const FIELDS: ReadonlyArray<readonly [keyof PersistedQuota, ioBroker.StateCommon]> = [
	['limit', { name: 'Requests allowed per window', type: 'number', role: 'value', read: true, write: false }],
	[
		'remaining',
		{ name: 'Requests left in the current window', type: 'number', role: 'value', read: true, write: false },
	],
	['resetAt', { name: 'When the window resets', type: 'number', role: 'date', read: true, write: false }],
	['lastRequestAt', { name: 'Last request sent', type: 'number', role: 'date', read: true, write: false }],
];

/** Legt die Ablage in den Zustandsbaum des Adapters. */
export class AdapterQuotaStore implements QuotaStore {
	private readonly api: QuotaStateApi;
	private objectsReady = false;

	/**
	 * @param api Der Ausschnitt der Adapter-Schnittstelle, in den geschrieben wird.
	 */
	public constructor(api: QuotaStateApi) {
		this.api = api;
	}

	/**
	 * Liest den zuletzt gespeicherten Zustand.
	 *
	 * Alles oder nichts: Ein halber Zustand waere schlimmer als keiner, weil der
	 * QuotaManager ihn fuer bare Muenze naehme.
	 *
	 * @returns Der Zustand, oder undefined beim ersten Start.
	 */
	public async load(): Promise<PersistedQuota | undefined> {
		await this.ensureObjects();
		const values: Partial<PersistedQuota> = {};
		for (const [field] of FIELDS) {
			const state = await this.api.getStateAsync(`${QUOTA_CHANNEL}.${field}`);
			if (typeof state?.val !== 'number' || !Number.isFinite(state.val)) {
				return undefined;
			}
			values[field] = state.val;
		}
		return values as PersistedQuota;
	}

	/**
	 * Schreibt den Zustand weg.
	 *
	 * @param state Der zu speichernde Zustand.
	 */
	public async save(state: PersistedQuota): Promise<void> {
		await this.ensureObjects();
		for (const [field] of FIELDS) {
			await this.api.setStateChangedAsync(`${QUOTA_CHANNEL}.${field}`, { val: state[field], ack: true });
		}
	}

	/** Legt Kanal und Zustaende an - einmal je Prozess. */
	private async ensureObjects(): Promise<void> {
		if (this.objectsReady) {
			return;
		}
		this.objectsReady = true;
		await this.api.setObjectNotExistsAsync(QUOTA_CHANNEL, {
			type: 'channel',
			common: { name: 'API rate limit' },
			native: {},
		});
		for (const [field, common] of FIELDS) {
			await this.api.setObjectNotExistsAsync(`${QUOTA_CHANNEL}.${field}`, {
				type: 'state',
				common,
				native: {},
			});
		}
	}
}
