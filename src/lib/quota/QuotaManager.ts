/**
 * Der QuotaManager - ein Bucket pro Instanz, durch den jeder Request muss (E9).
 *
 * Die harte Randbedingung des Projekts sind **20 Requests pro Stunde und
 * API-Schluessel**. Weder der PollScheduler (Phase 6) noch die CommandQueue (Phase 7)
 * rufen den Client direkt auf; sie fragen hier, ob sie duerfen, und melden hier, was
 * die Antwort ueber das Budget verraten hat.
 *
 * Drei Regeln bestimmen den Aufbau:
 *
 * 1. **Quelle der Wahrheit sind die `RateLimit-*`-Header, nie die eigene Zaehlung.**
 *    `remaining` wird ausschliesslich aus einer Antwort gesetzt. Solange keine
 *    vorliegt, ist der Wert eine Schaetzung - `snapshot().confirmed` sagt, welches
 *    von beidem gerade gilt.
 * 2. **Befehle haben Vorrang vor Polls.** Ein Poll wird abgelehnt, sobald nur noch die
 *    Reserve uebrig ist; ein Befehl darf sie aufbrauchen. Ein Poll liefert Daten, die
 *    in fuenfzehn Minuten ohnehin wieder kommen - ein Befehl, der am Budget scheitert,
 *    ist eine Klimatisierung, die nicht laeuft.
 * 3. **Ein Neustart darf nicht wie ein leerer Bucket aussehen.** Ohne Persistenz
 *    verbrennt eine Instanz in Neustartschleife 20 Requests in 90 Sekunden. Deshalb
 *    wandert der Zustand in einen Speicher (Phase 6 haengt ihn an `info.rateLimit.*`)
 *    und nach dem Start gilt eine Sperrfrist.
 */
import type { ApiMeta } from '../api/client';

/** Wofuer ein Request gebraucht wird. Befehle duerfen weiter gehen als Polls. */
export type RequestPriority = 'poll' | 'command';

/** Warum ein Request gerade nicht darf. */
export type DenialReason =
	/** Nur noch die Befehlsreserve uebrig - gilt nur fuer Polls. */
	| 'reserve'
	/** Budget aufgebraucht. */
	| 'exhausted'
	/** Sperrfrist nach einem Neustart. */
	| 'startup-guard';

/** Antwort auf die Frage, ob ein Request abgesetzt werden darf. */
export type AcquireResult = 'ok' | { waitMs: number; reason: DenialReason };

/** Der Zustand, der einen Neustart ueberleben muss. */
export interface PersistedQuota {
	/** Requests je Fenster, wie sie die API zuletzt gemeldet hat. */
	limit: number;
	/** Reststand beim Speichern, laufende Requests bereits abgezogen. */
	remaining: number;
	/** Zeitpunkt, an dem das Fenster zurueckgesetzt wird, in Millisekunden seit Epoch. */
	resetAt: number;
	/** Zeitpunkt des letzten abgesetzten Requests, in Millisekunden seit Epoch. */
	lastRequestAt: number;
}

/**
 * Ablage fuer den Zustand ueber einen Neustart hinweg.
 *
 * Bewusst als Schnittstelle und nicht als ioBroker-Zugriff: Der QuotaManager kennt
 * keine Adapter-Instanz, und die Tests brauchen keine. Phase 6 haengt hier eine
 * Umsetzung ein, die `info.rateLimit.*` liest und schreibt.
 */
export interface QuotaStore {
	/** Liest den zuletzt gespeicherten Zustand, oder undefined beim ersten Start. */
	load(): Promise<PersistedQuota | undefined>;
	/** Schreibt den Zustand weg. Fehler sind nicht toedlich, aber meldenswert. */
	save(state: PersistedQuota): Promise<void>;
}

/** Was der Bucket gerade ueber sich weiss. */
export interface QuotaSnapshot {
	/** Requests je Fenster. */
	limit: number;
	/** Zuletzt bekannter Reststand, ohne die gerade laufenden Requests. */
	remaining: number;
	/** Zeitpunkt, an dem das Fenster zurueckgesetzt wird. */
	resetAt: number;
	/** Wie viele Requests ein Poll noch hat, bevor die Befehlsreserve beginnt. */
	reserveFree: number;
	/** Abgesetzte, aber noch nicht beantwortete Requests. */
	inFlight: number;
	/** Zeitpunkt des letzten abgesetzten Requests, oder undefined. */
	lastRequestAt?: number;
	/** True, sobald eine Antwort dieses Prozesses die Zahlen bestaetigt hat. */
	confirmed: boolean;
}

/** Womit der Bucket eingerichtet wird. */
export interface QuotaManagerOptions {
	/** Requests je Fenster, bis die erste Antwort etwas anderes sagt. */
	limit?: number;
	/** Laenge des Fensters. */
	windowMs?: number;
	/** Reserve fuer Befehle: Polls werden abgelehnt, sobald `remaining <= reserve`. */
	commandReserve?: number;
	/** Sperrfrist nach einem Neustart. Vorgabe: ein gleichmaessiger Anteil am Fenster. */
	startupIntervalMs?: number;
	/** Persistenz. Ohne sie ueberlebt der Zustand keinen Neustart. */
	store?: QuotaStore;
	/** Zeitquelle, ersetzbar fuer Tests. */
	now?: () => number;
	/** Wird gerufen, wenn die Persistenz scheitert. Phase 6 haengt hier das Log ein. */
	onStoreError?: (error: unknown) => void;
}

/** 20 Requests pro Stunde, laut Doku "not final". */
export const DEFAULT_LIMIT = 20;

/** Das Fenster, auf das sich die 20 Requests beziehen. */
export const DEFAULT_WINDOW_MS = 3_600_000;

/** Vorgabe der Befehlsreserve. Ein Befehl kostet realistisch zwei bis drei Requests. */
export const DEFAULT_COMMAND_RESERVE = 6;

/**
 * Verwaltet das Stundenbudget einer Instanz: Wer fragen darf, wer warten muss, und was
 * die Antworten ueber den Reststand gesagt haben.
 */
export class QuotaManager {
	private readonly windowMs: number;
	private readonly commandReserve: number;
	private readonly startupIntervalMs: number;
	private readonly store?: QuotaStore;
	private readonly now: () => number;
	private readonly onStoreError?: (error: unknown) => void;

	private limit: number;
	private remaining: number;
	private resetAt: number;
	private lastRequestAt?: number;
	private inFlight = 0;
	private confirmed = false;

	/**
	 * Ende der Sperrfrist nach einem Neustart. Nur gesetzt, solange sie noch gilt -
	 * im laufenden Betrieb bestimmt die Kadenz den Abstand, nicht der Bucket.
	 */
	private startupGuardUntil?: number;

	/**
	 * @param options Grenzen, Reserve, Persistenz und Zeitquelle.
	 */
	public constructor(options: QuotaManagerOptions = {}) {
		this.limit = options.limit ?? DEFAULT_LIMIT;
		this.windowMs = options.windowMs ?? DEFAULT_WINDOW_MS;
		this.commandReserve = options.commandReserve ?? DEFAULT_COMMAND_RESERVE;
		// Ohne eigene Angabe der gleichmaessige Anteil am Fenster: 20 Requests pro
		// Stunde heisst, dass drei Minuten Abstand das Budget genau ausreichen lassen.
		this.startupIntervalMs = options.startupIntervalMs ?? Math.floor(this.windowMs / this.limit);
		this.store = options.store;
		this.now = options.now ?? (() => Date.now());
		this.onStoreError = options.onStoreError;

		this.remaining = this.limit;
		this.resetAt = this.now() + this.windowMs;
	}

	/**
	 * Holt den Zustand aus der Ablage zurueck und setzt die Sperrfrist.
	 *
	 * Ohne diesen Aufruf startet der Bucket mit vollem Budget - und genau das ist die
	 * Annahme, die eine Neustartschleife teuer macht.
	 *
	 * @returns Nichts; bei einem Fehler der Ablage bleibt der Startzustand stehen.
	 */
	public async start(): Promise<void> {
		if (!this.store) {
			return;
		}
		let persisted: PersistedQuota | undefined;
		try {
			persisted = await this.store.load();
		} catch (error: unknown) {
			this.onStoreError?.(error);
			return;
		}
		if (!persisted) {
			return;
		}

		const now = this.now();
		this.limit = persisted.limit > 0 ? persisted.limit : this.limit;
		if (now >= persisted.resetAt) {
			// Das Fenster ist waehrend der Auszeit abgelaufen: volles Budget.
			this.remaining = this.limit;
			this.resetAt = now + this.windowMs;
		} else {
			this.remaining = Math.min(persisted.remaining, this.limit);
			this.resetAt = persisted.resetAt;
		}

		this.lastRequestAt = persisted.lastRequestAt;
		// Die Sperrfrist gilt nur fuer den ersten Request nach dem Start. Sie bricht
		// die Neustartschleife: Jeder frische Prozess muss warten, bevor er fragt.
		const guardUntil = persisted.lastRequestAt + this.startupIntervalMs;
		if (guardUntil > now) {
			this.startupGuardUntil = guardUntil;
		}
	}

	/**
	 * Fragt, ob ein Request abgesetzt werden darf.
	 *
	 * Bei `ok` gilt der Request als unterwegs: Der Aufrufer muss ihn absetzen und
	 * anschliessend `recordResponse()` melden - auch im Fehlerfall, sonst bleibt der
	 * Platz dauerhaft belegt. Der Client liefert dafuer immer ein `meta`.
	 *
	 * @param priority Wofuer der Request gebraucht wird.
	 * @returns `ok`, oder die Wartezeit samt Grund.
	 */
	public tryAcquire(priority: RequestPriority): AcquireResult {
		const now = this.now();
		this.refreshWindow(now);

		if (this.startupGuardUntil !== undefined) {
			if (now < this.startupGuardUntil) {
				return { waitMs: this.startupGuardUntil - now, reason: 'startup-guard' };
			}
			this.startupGuardUntil = undefined;
		}

		// Ein Poll haelt die Reserve frei, ein Befehl darf sie aufbrauchen (E15).
		const floor = priority === 'poll' ? this.commandReserve : 0;
		if (this.available <= floor) {
			return {
				waitMs: Math.max(0, this.resetAt - now),
				reason: priority === 'poll' ? 'reserve' : 'exhausted',
			};
		}

		this.inFlight += 1;
		this.lastRequestAt = now;
		// Vor dem Request speichern, nicht erst nach der Antwort: Ein Absturz genau
		// dazwischen ist der Fall, gegen den die Sperrfrist ueberhaupt gebaut ist.
		this.persist();
		return 'ok';
	}

	/**
	 * Meldet, was eine Antwort ueber das Budget gesagt hat.
	 *
	 * Erwartet das `meta` des Clients und nicht die rohen Header: Die Auswertung der
	 * `RateLimit-*`-Header steht in Schicht 1 und soll nicht ein zweites Mal
	 * danebenstehen.
	 *
	 * @param meta Die Begleitangaben aus `ApiResult`.
	 */
	public recordResponse(meta: ApiMeta): void {
		const now = this.now();
		this.inFlight = Math.max(0, this.inFlight - 1);

		if (meta.rateLimit) {
			// Die Header sind die Wahrheit, auch wenn sie mehr melden als erwartet.
			this.limit = meta.rateLimit.limit > 0 ? meta.rateLimit.limit : this.limit;
			this.remaining = Math.max(0, Math.min(meta.rateLimit.remaining, this.limit));
			this.resetAt = now + meta.rateLimit.resetInSeconds * 1000;
			this.confirmed = true;
		} else if (meta.consumedQuota) {
			// Keine Header, also ein Netzwerkfehler: Der Verbrauch ist unbekannt und
			// wird konservativ als verbraucht gezaehlt.
			this.remaining = Math.max(0, this.remaining - 1);
		}

		this.persist();
	}

	/**
	 * Der aktuelle Stand, wie ihn Phase 6 loggt und Phase 9 in `info.*` schreibt.
	 *
	 * @returns Grenzen, Reststand, Reserve und Zeitpunkt des Zuruecksetzens.
	 */
	public snapshot(): QuotaSnapshot {
		this.refreshWindow(this.now());
		return {
			limit: this.limit,
			remaining: this.remaining,
			resetAt: this.resetAt,
			reserveFree: Math.max(0, this.available - this.commandReserve),
			inFlight: this.inFlight,
			lastRequestAt: this.lastRequestAt,
			confirmed: this.confirmed,
		};
	}

	/** Was nach Abzug der laufenden Requests tatsaechlich noch frei ist. */
	private get available(): number {
		return Math.max(0, this.remaining - this.inFlight);
	}

	/**
	 * Setzt das Fenster zurueck, wenn seine Zeit abgelaufen ist.
	 *
	 * Das ist eine Schaetzung: Bis zur naechsten Antwort weiss niemand, ob die API
	 * genauso rechnet. Die naechste Antwort korrigiert sie.
	 *
	 * @param now Jetzt-Zeitpunkt in Millisekunden.
	 */
	private refreshWindow(now: number): void {
		if (now >= this.resetAt) {
			this.remaining = this.limit;
			this.resetAt = now + this.windowMs;
			this.confirmed = false;
		}
	}

	/**
	 * Schreibt den Zustand in die Ablage.
	 *
	 * Gespeichert wird der um die laufenden Requests verminderte Stand: Wer mitten im
	 * Request abstuerzt, soll nach dem Neustart nicht glauben, er haette ihn nie
	 * abgesetzt. Ein Fehler der Ablage ist kein Grund, den Betrieb anzuhalten - er
	 * kostet nur den Schutz beim naechsten Neustart.
	 */
	private persist(): void {
		if (!this.store || this.lastRequestAt === undefined) {
			return;
		}
		const state: PersistedQuota = {
			limit: this.limit,
			remaining: this.available,
			resetAt: this.resetAt,
			lastRequestAt: this.lastRequestAt,
		};
		void this.store.save(state).catch((error: unknown) => this.onStoreError?.(error));
	}
}
