/**
 * Ablage des Quota-Zustands in `<VIN>.rateLimit.*`.
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
import { translated } from '../i18n';

/** Der Ausschnitt der Adapter-Schnittstelle, den die Ablage braucht. */
export interface QuotaStateApi {
	/** Legt ein Objekt an, sofern es noch keines gibt. */
	setObjectNotExistsAsync(id: string, obj: ioBroker.SettableObject): ioBroker.SetObjectPromise;
	/** Liest einen Zustand. */
	getStateAsync(id: string): ioBroker.GetStatePromise;
	/** Schreibt einen Zustand, sofern er sich geaendert hat. */
	setStateChangedAsync(id: string, state: ioBroker.SettableState): ioBroker.SetStateChangedPromise;
	/** Liest vorhandene Metadaten fuer die Sprachmigration. */
	getObjectAsync(id: string): ioBroker.GetObjectPromise;
	/** Aktualisiert nur den Standardnamen eines vorhandenen Objekts. */
	extendObjectAsync(id: string, obj: ioBroker.PartialObject): ioBroker.SetObjectPromise;
}

/**
 * Kanal, unter dem die vier Zustaende eines Fahrzeugs liegen.
 *
 * @param vin Fahrzeug des Buckets.
 */
export function quotaChannel(vin: string): string {
	return `${vin}.rateLimit`;
}

/** Alter instanzweiter Ablageort; nur als konservativer Upgrade-Fallback gelesen. */
export const LEGACY_QUOTA_CHANNEL = 'info.rateLimit';

/** Die vier Zustaende und ihr `common`. */
const FIELDS: ReadonlyArray<readonly [keyof PersistedQuota, ioBroker.StateCommon]> = [
	[
		'limit',
		{
			name: translated('Requests allowed per window', 'Erlaubte Requests pro Zeitfenster'),
			type: 'number',
			role: 'value',
			read: true,
			write: false,
		},
	],
	[
		'remaining',
		{
			name: translated('Requests left in the current window', 'Verbleibende Requests im aktuellen Zeitfenster'),
			type: 'number',
			role: 'value',
			read: true,
			write: false,
		},
	],
	[
		'resetAt',
		{
			name: translated('When the window resets', 'Zeitpunkt der Rücksetzung des Zeitfensters'),
			type: 'number',
			role: 'date',
			read: true,
			write: false,
		},
	],
	[
		'lastRequestAt',
		{
			name: translated('Last request sent', 'Zeitpunkt des letzten Requests'),
			type: 'number',
			role: 'date',
			read: true,
			write: false,
		},
	],
];

/** Legt die Ablage in den Zustandsbaum des Adapters. */
export class AdapterQuotaStore implements QuotaStore {
	private readonly api: QuotaStateApi;
	private readonly channel: string;
	private objectsReady = false;

	/**
	 * @param api Der Ausschnitt der Adapter-Schnittstelle, in den geschrieben wird.
	 * @param vin Fahrzeug, dessen Bucket gespeichert wird.
	 */
	public constructor(api: QuotaStateApi, vin: string) {
		this.api = api;
		this.channel = quotaChannel(vin);
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
		return (await this.read(this.channel)) ?? this.read(LEGACY_QUOTA_CHANNEL);
	}

	/**
	 * Liest einen vollstaendigen Bucket von einem bestimmten Kanal.
	 *
	 * @param channel Relativer ioBroker-Kanal.
	 * @returns Vollstaendiger Stand oder undefined.
	 */
	private async read(channel: string): Promise<PersistedQuota | undefined> {
		const values: Partial<PersistedQuota> = {};
		for (const [field] of FIELDS) {
			const state = await this.api.getStateAsync(`${channel}.${field}`);
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
			await this.api.setStateChangedAsync(`${this.channel}.${field}`, { val: state[field], ack: true });
		}
	}

	/** Legt Kanal und Zustaende an - einmal je Prozess. */
	private async ensureObjects(): Promise<void> {
		if (this.objectsReady) {
			return;
		}
		this.objectsReady = true;
		await this.api.setObjectNotExistsAsync(this.channel, {
			type: 'channel',
			common: { name: translated('API rate limit for this vehicle', 'API-Limit für dieses Fahrzeug') },
			native: {},
		});
		await this.migrateName(
			this.channel,
			translated('API rate limit for this vehicle', 'API-Limit für dieses Fahrzeug'),
		);
		for (const [field, common] of FIELDS) {
			const id = `${this.channel}.${field}`;
			await this.api.setObjectNotExistsAsync(id, {
				type: 'state',
				common,
				native: {},
			});
			await this.migrateName(id, common.name);
		}
	}

	/**
	 * Migrates adapter defaults while preserving names changed by the user.
	 *
	 * @param id Relative Objekt-ID.
	 * @param name Neuer zweisprachiger Standardname.
	 */
	private async migrateName(id: string, name: ioBroker.StringOrTranslated): Promise<void> {
		if (typeof name === 'string') {
			return;
		}
		const existing = await this.api.getObjectAsync(id);
		if (existing && existing.common.name === name.en) {
			await this.api.extendObjectAsync(id, { common: { name } });
		}
	}
}
