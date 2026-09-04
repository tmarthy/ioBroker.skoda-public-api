/**
 * Der Ablauf des API-Schluessels (E10).
 *
 * Der Schluessel aus der MySkoda-App gilt nur eine begrenzte Zeit, und **erneuern kann
 * ihn nur ein Mensch mit dem Handy in der Hand** - automatisch geht das nicht, die API
 * bietet es nicht an. Zugleich faellt sein Ablauf von selbst kaum auf: Fehlende Teile
 * behalten laut E8 ihren letzten Wert, die VIS zeigt also weiter Zahlen an. Ohne aktive
 * Meldung merkt man wochenlang nichts.
 *
 * Deshalb drei Stufen, jede hoechstens einmal am Tag:
 *
 * | Restlaufzeit | Log | Notification |
 * |---|---|---|
 * | 14 Tage | `info` | - |
 * | 7 Tage | `warn` | `apiKeyExpiring` |
 * | 2 Tage | `error` | `apiKeyExpiring` |
 * | abgelaufen oder `401 api-key-expired` | `error` | `apiKeyExpired` |
 *
 * Das Ablaufdatum steht im Header `X-API-Key-Expires-At` **jeder** Antwort; der Client
 * reicht es als `meta.apiKeyExpiresAt` hoch. Es kostet also nichts, es bei jedem Poll
 * nachzusehen.
 */
import type { ApiMeta } from '../api/client';
import type { ApiError } from '../api/errors';

/** Schwellen in Tagen, aufsteigend: Die kleinste passende bestimmt die Dringlichkeit. */
export const EXPIRY_THRESHOLDS_DAYS = [2, 7, 14] as const;

/** Ab dieser Schwelle geht zusaetzlich eine Notification hinaus (E10). */
export const NOTIFY_FROM_DAYS = 7;

/** Die Kategorien, die `io-package.json` unter `notifications` anmeldet. */
export type KeyNotificationCategory = 'apiKeyExpiring' | 'apiKeyExpired';

/** Kanal und Zustaende des Schluessels. */
export const API_KEY_CHANNEL = 'info.apiKey';

/** Der Ausschnitt der Adapter-Schnittstelle, den der Waechter braucht. */
export interface KeyExpiryStateApi {
	/** Legt ein Objekt an, sofern es noch keines gibt. */
	setObjectNotExistsAsync(id: string, obj: ioBroker.SettableObject): ioBroker.SetObjectPromise;
	/** Schreibt einen Zustand, sofern er sich geaendert hat. */
	setStateChangedAsync(id: string, state: ioBroker.SettableState): ioBroker.SetStateChangedPromise;
}

/** Die Logstufen, die der Waechter benutzt. */
export interface KeyExpiryLog {
	/** Erste Vorwarnung, 14 Tage. */
	info(message: string): void;
	/** Zweite Stufe, 7 Tage. */
	warn(message: string): void;
	/** Letzte Stufe und der abgelaufene Schluessel. */
	error(message: string): void;
}

/** Womit der Waechter eingerichtet wird. */
export interface KeyExpiryOptions {
	/** Wohin `info.apiKey.*` geschrieben wird. */
	states: KeyExpiryStateApi;
	/** Wohin die Meldungen gehen. */
	log: KeyExpiryLog;
	/** `registerNotification()` der Adapter-Instanz. */
	notify?: (category: KeyNotificationCategory, message: string) => Promise<void> | void;
	/** Zeitquelle, ersetzbar fuer Tests. */
	now?: () => number;
}

/**
 * Beobachtet das Ablaufdatum des Schluessels und schlaegt rechtzeitig Alarm.
 */
export class KeyExpiryWatcher {
	private readonly states: KeyExpiryStateApi;
	private readonly log: KeyExpiryLog;
	private readonly notify?: KeyExpiryOptions['notify'];
	private readonly now: () => number;

	/** Was an welchem Tag schon gemeldet wurde - Schluessel auf Tagesnummer. */
	private readonly announced = new Map<string, number>();
	private objectsReady = false;

	/**
	 * @param options Zustandsschnittstelle, Log, Notification-Kanal und Zeitquelle.
	 */
	public constructor(options: KeyExpiryOptions) {
		this.states = options.states;
		this.log = options.log;
		this.notify = options.notify;
		this.now = options.now ?? (() => Date.now());
	}

	/**
	 * Wertet eine Antwort aus.
	 *
	 * @param meta Die Begleitangaben, die der Client hochreicht.
	 * @param error Der Fehler, falls die Antwort einer war.
	 */
	public async observe(meta: ApiMeta, error?: ApiError): Promise<void> {
		if (error?.kind === 'api-key-expired') {
			// Die API sagt es ausdruecklich - das schlaegt jede Rechnerei mit Tagen.
			await this.announceExpired('Der API-Schlüssel ist abgelaufen.');
			return;
		}

		if (!meta.apiKeyExpiresAt) {
			return;
		}

		const remainingDays = Math.floor((meta.apiKeyExpiresAt.getTime() - this.now()) / 86_400_000);
		await this.writeStates(meta.apiKeyExpiresAt, remainingDays);

		if (remainingDays > EXPIRY_THRESHOLDS_DAYS[EXPIRY_THRESHOLDS_DAYS.length - 1]) {
			// Weit weg vom Ablauf: Ein erneuerter Schluessel soll spaeter wieder alle
			// Stufen durchlaufen koennen.
			this.announced.clear();
			return;
		}

		if (remainingDays <= 0) {
			await this.announceExpired('Der API-Schlüssel ist abgelaufen oder läuft heute ab.');
			return;
		}

		const threshold = EXPIRY_THRESHOLDS_DAYS.find(days => remainingDays <= days);
		if (threshold === undefined || !this.isNewToday(`expiring-${threshold}`)) {
			return;
		}

		const message =
			`Der API-Schlüssel läuft in ${remainingDays} Tag${remainingDays === 1 ? '' : 'en'} ab ` +
			`(${meta.apiKeyExpiresAt.toISOString().slice(0, 10)}). Ein neuer wird in der MyŠkoda-App erzeugt; ` +
			'automatisch erneuern kann der Adapter ihn nicht.';

		if (threshold <= 2) {
			this.log.error(message);
		} else if (threshold <= 7) {
			this.log.warn(message);
		} else {
			this.log.info(message);
		}

		if (threshold <= NOTIFY_FROM_DAYS) {
			await this.notify?.('apiKeyExpiring', message);
		}
	}

	/**
	 * Meldet einen abgelaufenen Schluessel - hoechstens einmal am Tag.
	 *
	 * @param reason Was dazu gefuehrt hat.
	 */
	private async announceExpired(reason: string): Promise<void> {
		if (!this.isNewToday('expired')) {
			return;
		}
		const message =
			`${reason} Der Adapter fragt bis auf Weiteres nur noch einmal pro Stunde nach. ` +
			'In der MyŠkoda-App unter "API-Schlüssel" einen neuen erzeugen und in der Instanz eintragen.';
		this.log.error(message);
		await this.notify?.('apiKeyExpired', message);
	}

	/**
	 * Schreibt `info.apiKey.expiresAt` und `.daysRemaining`.
	 *
	 * @param expiresAt Ablaufzeitpunkt aus dem Header.
	 * @param remainingDays Volle Tage bis dahin.
	 */
	private async writeStates(expiresAt: Date, remainingDays: number): Promise<void> {
		await this.ensureObjects();
		await this.states.setStateChangedAsync(`${API_KEY_CHANNEL}.expiresAt`, {
			val: expiresAt.toISOString(),
			ack: true,
		});
		await this.states.setStateChangedAsync(`${API_KEY_CHANNEL}.daysRemaining`, {
			val: remainingDays,
			ack: true,
		});
	}

	/** Legt Kanal und Zustaende an - einmal je Prozess. */
	private async ensureObjects(): Promise<void> {
		if (this.objectsReady) {
			return;
		}
		this.objectsReady = true;
		await this.states.setObjectNotExistsAsync(API_KEY_CHANNEL, {
			type: 'channel',
			common: { name: 'API key' },
			native: {},
		});
		// Der Zeitpunkt bleibt die Zeichenkette aus dem Header - so, wie alle anderen
		// Zeitstempel dieser API auch im Baum stehen.
		await this.states.setObjectNotExistsAsync(`${API_KEY_CHANNEL}.expiresAt`, {
			type: 'state',
			common: { name: 'When the API key expires', type: 'string', role: 'date', read: true, write: false },
			native: {},
		});
		await this.states.setObjectNotExistsAsync(`${API_KEY_CHANNEL}.daysRemaining`, {
			type: 'state',
			common: {
				name: 'Days left before the API key expires',
				type: 'number',
				role: 'value',
				unit: 'd',
				read: true,
				write: false,
			},
			native: {},
		});
	}

	/**
	 * Sagt, ob eine Meldung heute schon herausging - und merkt sie sich.
	 *
	 * @param key Kennung der Meldung.
	 * @returns True, wenn sie heute noch nicht kam.
	 */
	private isNewToday(key: string): boolean {
		const today = Math.floor(this.now() / 86_400_000);
		if (this.announced.get(key) === today) {
			return false;
		}
		this.announced.set(key, today);
		return true;
	}
}
