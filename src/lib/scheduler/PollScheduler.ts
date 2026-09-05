/**
 * PollScheduler - bestimmt, wann welches Fahrzeug abgefragt wird.
 *
 * Er ist die Stelle, an der aus 20 Requests pro Stunde ein brauchbarer Adapter wird.
 * Vier Regeln bestimmen die Kadenz (siehe docs/implementation-plan.md, Phase 6):
 *
 * | Zustand | Intervall |
 * |---|---|
 * | Basis | 15 min |
 * | Aktiv (laedt oder klimatisiert) | 5 min |
 * | Nach einem Befehl | Verifikations-Poll nach 60 s, danach 10 min aktive Kadenz |
 * | Frische-Backoff | Verdopplung bei unveraendertem Zeitstempel, Deckel 60 min |
 *
 * **Der Frische-Backoff ist der groesste Einzelhebel.** Ein schlafendes Auto liefert
 * bei jedem Poll denselben `carCapturedTimestamp`: Schneller zu fragen bringt null
 * Information und kostet volles Budget. Verglichen wird nach Millisekunden, nie als
 * Zeichenkette - an dieser API haengen 0 bis 9 Nachkommastellen.
 *
 * Der Scheduler fragt **immer** zuerst den QuotaManager und schreibt selbst keine
 * Zustaende: Die Antwort geht ueber `onVehicleData` nach oben an den StateWriter.
 * So bleibt die Schichtung aus dem Architekturbild erhalten.
 */
import { vehicleErrors, type ApiMeta, type ApiResult } from '../api/client';
import type { ApiError } from '../api/errors';
import { partFromErrorType } from '../api/parts';
import { VEHICLE_PARTS, type VehiclePart, type VehicleResponse } from '../api/types';
import { detectParts, newestCapturedAt } from '../api/vehicleData';
import type { VehicleQuota } from '../quota/VehicleQuotaManager';
import { COMMAND_DEFS } from '../states/commandDefs';

/** Der Ausschnitt des Clients, den der Scheduler braucht. */
export interface VehicleReader {
	/** Holt den Zustand eines Fahrzeugs, wahlweise auf Teile beschraenkt. */
	getVehicle(vin: string, include?: readonly VehiclePart[]): Promise<ApiResult<VehicleResponse>>;
}

/** Die Logstufen, die der Scheduler benutzt. */
export interface SchedulerLog {
	/** Kadenz und verschobene Polls - im Normalbetrieb uninteressant. */
	debug(message: string): void;
	/** Einmalige Erkenntnisse, etwa was das Fahrzeug liefert. */
	info(message: string): void;
	/** Stoerungen, die von selbst vorbeigehen. */
	warn(message: string): void;
	/** Stoerungen, die einen Menschen brauchen. */
	error(message: string): void;
}

/** Alle Zeitwerte der Kadenz, in Millisekunden. */
export interface PollIntervals {
	/** Grundkadenz, wenn nichts passiert. */
	idleMs: number;
	/** Kadenz, solange geladen oder klimatisiert wird. */
	activeMs: number;
	/** Deckel des Frische-Backoffs. */
	backoffMaxMs: number;
	/** Abstand des Verifikations-Polls nach einem Befehl. */
	verificationMs: number;
	/** Wie lange nach einem Befehl die aktive Kadenz gilt. */
	commandModeMs: number;
	/** Kadenz nach 401/403 - ein abgelaufener Schluessel repariert sich nicht (E10). */
	errorMs: number;
	/** Grundwartezeit vor einer Wiederholung; sie bekommt Jitter (E15). */
	retryMs: number;
}

export const DEFAULT_INTERVALS: PollIntervals = {
	idleMs: 15 * 60_000,
	activeMs: 5 * 60_000,
	backoffMaxMs: 60 * 60_000,
	verificationMs: 60_000,
	commandModeMs: 10 * 60_000,
	errorMs: 60 * 60_000,
	retryMs: 15_000,
};

/** Untergrenzen aus dem Plan - schneller darf niemand einstellen. */
export const MIN_IDLE_MS = 5 * 60_000;
export const MIN_ACTIVE_MS = 3 * 60_000;

/** Ein Zeitgeber-Handle; der Adapter reicht seinen eigenen herein. */
export type TimerHandle = unknown;

/** Womit der Scheduler eingerichtet wird. */
export interface PollSchedulerOptions {
	/** Die HTTP-Schicht. */
	client: VehicleReader;
	/** Das Budget; ohne seine Zustimmung geht kein Request hinaus. */
	quota: VehicleQuota;
	/** Die konfigurierten Fahrgestellnummern. Jede VIN hat ein eigenes Budget. */
	vins: readonly string[];
	/** Wohin die Antwort geht - in Phase 6 der StateWriter. */
	onVehicleData: (vin: string, response: VehicleResponse) => Promise<void> | void;
	/** Wohin die Meldungen gehen. */
	log: SchedulerLog;
	/** Meldet Wechsel von `info.connection` (E10). */
	onConnectionChange?: (connected: boolean) => void;
	/**
	 * Wird nach **jeder** Antwort gerufen, auch nach einer fehlerhaften.
	 *
	 * Daran haengt der Schluesselablauf: `X-API-Key-Expires-At` steht in jeder Antwort,
	 * es kostet also nichts, ihn bei jedem Poll nachzusehen (E10).
	 */
	onResponse?: (meta: ApiMeta, error?: ApiError) => void;
	/** Abweichungen von den Vorgabewerten. */
	intervals?: Partial<PollIntervals>;
	/** Parkposition mitlesen. Aus heisst: gar nicht erst anfordern (E14). */
	readParkingPosition?: boolean;
	/** Zeitquelle, ersetzbar fuer Tests. */
	now?: () => number;
	/** Zufall fuer den Jitter, ersetzbar fuer Tests. */
	random?: () => number;
	/** Zeitgeber; der Adapter reicht `setTimeout` seiner Instanz herein. */
	setTimer?: (handler: () => void, ms: number) => TimerHandle;
	/** Gegenstueck zu `setTimer`. */
	clearTimer?: (handle: TimerHandle) => void;
}

/** Was der Scheduler ueber ein Fahrzeug weiss. */
interface VehicleState {
	vin: string;
	/** Wann der naechste Poll faellig ist, in Millisekunden seit Epoch. */
	nextDueAt: number;
	/** Gelernte Teile. Undefined heisst: noch kein erfolgreicher Poll. */
	parts?: VehiclePart[];
	/** Zeitpunkt der zuletzt gesehenen Fahrzeugdaten, in Millisekunden. */
	lastCapturedAt?: number;
	/** Verdopplungsfaktor des Frische-Backoffs. */
	backoff: number;
	/** Laedt oder klimatisiert das Fahrzeug gerade? */
	active: boolean;
	/** Bis wann nach einem Befehl die aktive Kadenz gilt. */
	commandModeUntil?: number;
	/** Noch ausstehende Verifikation; bleibt auch waehrend eines laufenden Polls erhalten. */
	verificationDueAt?: number;
	/** Wiederholungen des laufenden Fehlers. */
	attempts: number;
	/** Erfolgreich gelesene, aber noch nicht vollstaendig geschriebene Antwort. */
	pendingWrite?: { response: VehicleResponse; unchanged: boolean };
	/** Dauerhaft ausgesetzt - die VIN gibt es unter diesem Schluessel nicht (404). */
	suspended: boolean;
}

/** Momentaufnahme fuer Tests und Logausgaben. */
export interface VehicleScheduleSnapshot {
	/** Fahrgestellnummer. */
	vin: string;
	/** Faelligkeit des naechsten Polls, in Millisekunden seit Epoch. */
	nextDueAt: number;
	/** Die derzeit geltende Kadenz, Backoff eingerechnet. */
	intervalMs: number;
	/** Verdopplungsfaktor des Frische-Backoffs. */
	backoff: number;
	/** Laedt oder klimatisiert das Fahrzeug gerade? */
	active: boolean;
	/** Dauerhaft ausgesetzt (404). */
	suspended: boolean;
	/** Die gelernten Teile, sobald der erste Poll durch ist. */
	parts?: VehiclePart[];
}

/** Kuerzeste Pause zwischen zwei Durchlaeufen - gegen eine Schleife auf der Stelle. */
const MIN_SLEEP_MS = 1_000;

/**
 * Faehrt die Abfrage der konfigurierten Fahrzeuge und haelt dabei die Kadenz ein.
 */
export class PollScheduler {
	private readonly client: VehicleReader;
	private readonly quota: VehicleQuota;
	private readonly onVehicleData: PollSchedulerOptions['onVehicleData'];
	private readonly onConnectionChange?: (connected: boolean) => void;
	private readonly onResponse?: (meta: ApiMeta, error?: ApiError) => void;
	private readonly log: SchedulerLog;
	private readonly intervals: PollIntervals;
	private readonly readParkingPosition: boolean;
	private readonly now: () => number;
	private readonly random: () => number;
	private readonly setTimer: (handler: () => void, ms: number) => TimerHandle;
	private readonly clearTimer: (handle: TimerHandle) => void;

	private readonly states = new Map<string, VehicleState>();
	private running = false;
	private timer?: TimerHandle;
	private tickTask?: Promise<number>;
	private connected?: boolean;

	/**
	 * @param options Client, Budget, Fahrzeuge und alle Zeitwerte.
	 */
	public constructor(options: PollSchedulerOptions) {
		this.client = options.client;
		this.quota = options.quota;
		this.onVehicleData = options.onVehicleData;
		this.onConnectionChange = options.onConnectionChange;
		this.onResponse = options.onResponse;
		this.log = options.log;
		this.readParkingPosition = options.readParkingPosition ?? true;
		this.now = options.now ?? (() => Date.now());
		this.random = options.random ?? Math.random;
		this.setTimer = options.setTimer ?? ((handler, ms) => setTimeout(handler, ms));
		this.clearTimer = options.clearTimer ?? (handle => clearTimeout(handle as NodeJS.Timeout));

		const wanted = { ...DEFAULT_INTERVALS, ...options.intervals };
		// Die Untergrenzen aus dem Plan gelten hier und nicht in der Admin-UI: Wer die
		// Konfiguration von Hand schreibt, soll das Budget genauso wenig zerlegen
		// koennen wie jemand, der ein Formular ausfuellt.
		this.intervals = {
			...wanted,
			idleMs: Math.max(MIN_IDLE_MS, wanted.idleMs),
			activeMs: Math.max(MIN_ACTIVE_MS, wanted.activeMs),
			backoffMaxMs: Math.max(wanted.backoffMaxMs, Math.max(MIN_IDLE_MS, wanted.idleMs)),
		};

		const now = this.now();
		for (const vin of options.vins) {
			this.states.set(vin, { vin, nextDueAt: now, backoff: 1, active: false, attempts: 0, suspended: false });
		}
	}

	/** Startet die Schleife. Der erste Poll geht sofort hinaus. */
	public start(): void {
		if (this.running) {
			return;
		}
		this.running = true;
		this.arm(0);
	}

	/** Haelt die Schleife an. Muss beim Entladen des Adapters gerufen werden. */
	public stop(): void {
		this.running = false;
		if (this.timer !== undefined) {
			this.clearTimer(this.timer);
			this.timer = undefined;
		}
	}

	/**
	 * Fuehrt alle faelligen Polls aus.
	 *
	 * Oeffentlich, damit Tests die Zeit selbst in die Hand nehmen koennen: Eine
	 * simulierte Stunde besteht aus `tick()` und dem Vorstellen der Uhr um die
	 * zurueckgegebene Wartezeit.
	 *
	 * @returns Millisekunden bis zum naechsten faelligen Poll.
	 */
	public tick(): Promise<number> {
		this.tickTask ??= this.runTick().finally(() => {
			this.tickTask = undefined;
		});
		return this.tickTask;
	}

	/** Fuehrt hoechstens einen Durchlauf gleichzeitig aus, auch bei vorgezogenen Polls. */
	private async runTick(): Promise<number> {
		for (const state of this.states.values()) {
			if (state.suspended || state.nextDueAt > this.now()) {
				continue;
			}
			await this.pollOne(state);
		}
		return this.msUntilNextDue();
	}

	/**
	 * Zieht nach einem Befehl einen Verifikations-Poll vor.
	 *
	 * Die API antwortet auf Befehle mit `202` und kennt keinen Status-Endpunkt - ob
	 * das Fahrzeug den Befehl ausgefuehrt hat, zeigt erst der naechste Poll. Die
	 * CommandQueue aus Phase 7 ruft das hier.
	 *
	 * @param vin Fahrgestellnummer.
	 */
	public requestVerificationPoll(vin: string): void {
		const state = this.states.get(vin);
		if (!state || state.suspended) {
			return;
		}
		const now = this.now();
		state.commandModeUntil = now + this.intervals.commandModeMs;
		// Ein Befehl aendert den Zustand des Fahrzeugs: Der Backoff eines schlafenden
		// Autos gilt ab jetzt nicht mehr.
		state.backoff = 1;
		state.verificationDueAt = Math.min(state.verificationDueAt ?? Infinity, now + this.intervals.verificationMs);
		state.nextDueAt = Math.min(state.nextDueAt, now + this.intervals.verificationMs);
		this.wake();
	}

	/**
	 * Der aktuelle Stand je Fahrzeug.
	 *
	 * @returns Faelligkeit, Kadenz und gelernte Teile.
	 */
	public snapshot(): VehicleScheduleSnapshot[] {
		return [...this.states.values()].map(state => ({
			vin: state.vin,
			nextDueAt: state.nextDueAt,
			intervalMs: this.intervalFor(state),
			backoff: state.backoff,
			active: state.active,
			suspended: state.suspended,
			parts: state.parts,
		}));
	}

	/**
	 * Fragt ein Fahrzeug ab, sofern das Budget es hergibt.
	 *
	 * @param state Der Zustand des Fahrzeugs.
	 */
	private async pollOne(state: VehicleState): Promise<void> {
		if (state.pendingWrite) {
			const pending = state.pendingWrite;
			await this.deliverVehicleData(state, pending.response, pending.unchanged);
			return;
		}

		const permission = this.quota.tryAcquire(state.vin, 'poll');
		if ('reason' in permission) {
			// Kein Fehler, sondern Normalbetrieb: Das Budget gehoert ab hier den
			// Befehlen (E15). Der Poll kommt wieder, wenn das Fenster sich oeffnet.
			state.nextDueAt = this.now() + Math.max(MIN_SLEEP_MS, permission.waitMs);
			this.log.debug(
				`Poll fuer ${maskVin(state.vin)} verschoben (${permission.reason}), ` +
					`naechster Versuch in ${Math.round(permission.waitMs / 1000)} s`,
			);
			return;
		}

		if (state.verificationDueAt !== undefined && this.now() >= state.verificationDueAt) {
			state.verificationDueAt = undefined;
		}
		const result = await this.client.getVehicle(state.vin, this.includeFor(state));
		this.quota.recordResponse(state.vin, result.meta, permission);
		this.onResponse?.(result.meta, result.ok ? undefined : result.error);

		if (result.ok) {
			await this.handleSuccess(state, result.data);
		} else {
			this.handleError(state, result.error);
		}
	}

	/**
	 * Wertet eine erfolgreiche Antwort aus und legt die naechste Faelligkeit fest.
	 *
	 * @param state Der Zustand des Fahrzeugs.
	 * @param response Die Antwort.
	 */
	private async handleSuccess(state: VehicleState, response: VehicleResponse): Promise<void> {
		state.attempts = 0;
		this.setConnected(true);
		this.learnParts(state, response);

		const vehicle = response.vehicle as unknown as Record<string, unknown>;
		const captured = newestCapturedAt(vehicle);
		const unchanged = captured !== undefined && captured === state.lastCapturedAt;
		if (unchanged && !this.inCommandMode(state)) {
			// Dieselben Daten wie beim letzten Mal: Das Auto schlaeft.
			state.backoff *= 2;
		} else if (!unchanged) {
			state.backoff = 1;
		}
		// Waehrend des Befehlsfensters greift der Backoff bewusst nicht: Dass das
		// Fahrzeug 60 Sekunden nach einem Befehl noch nichts gemeldet hat, ist der
		// Normalfall - und genau deshalb wird ja nachgesehen.
		if (captured !== undefined) {
			state.lastCapturedAt = captured;
		}
		state.active = this.isActive(vehicle);

		await this.deliverVehicleData(state, response, unchanged);
	}

	/**
	 * Reicht bereits gelesene Fahrzeugdaten nach oben und wiederholt bei einem Fehler
	 * nur diesen lokalen Schritt. Der teure HTTP-Request bleibt dabei abgeschlossen.
	 *
	 * @param state Zeitplan des Fahrzeugs.
	 * @param response Bereits erfolgreich gelesene Antwort.
	 * @param unchanged Ob der Fahrzeug-Zeitstempel unveraendert war.
	 */
	private async deliverVehicleData(
		state: VehicleState,
		response: VehicleResponse,
		unchanged: boolean,
	): Promise<void> {
		try {
			await this.onVehicleData(state.vin, response);
		} catch (error: unknown) {
			state.pendingWrite = { response, unchanged };
			state.nextDueAt = this.now() + this.intervals.retryMs;
			this.log.error(
				`Fahrzeugdaten fuer ${maskVin(state.vin)} konnten nicht geschrieben werden: ${String(error)}. ` +
					`Neuer Schreibversuch in ${Math.round(this.intervals.retryMs / 1000)} s, ohne API-Abfrage.`,
			);
			return;
		}

		state.pendingWrite = undefined;
		const interval = this.intervalFor(state);
		state.nextDueAt = Math.min(this.now() + interval, state.verificationDueAt ?? Infinity);
		this.log.debug(
			`Poll fuer ${maskVin(state.vin)}: ${state.active ? 'aktiv' : 'ruhend'}` +
				`${unchanged ? `, unveraendert (Backoff ${state.backoff})` : ''}, ` +
				`naechster in ${Math.round(interval / 60_000)} min`,
		);
	}

	/**
	 * Entscheidet nach der Fehlertabelle, wie es mit diesem Fahrzeug weitergeht.
	 *
	 * Die Tabelle steht nicht hier: `retryable`, `maxRetries` und `retryAfterMs`
	 * bringt der Fehler aus Schicht 1 bereits mit. Hier stehen nur die Folgen fuer die
	 * Kadenz.
	 *
	 * @param state Der Zustand des Fahrzeugs.
	 * @param error Der Fehler aus dem Client.
	 */
	private handleError(state: VehicleState, error: ApiError): void {
		const now = this.now();

		if (error.status === 404) {
			// Diese VIN gibt es unter diesem Schluessel nicht. Weiterfragen kostet nur
			// Budget - bis zur naechsten Konfigurationsaenderung ist hier Schluss.
			state.suspended = true;
			this.log.error(`Fahrzeug ${maskVin(state.vin)} nicht gefunden - Polling ausgesetzt. ${error.message}`);
			return;
		}

		if (error.kind === 'api-key-expired' || error.kind === 'api-key-not-authorized') {
			// Repariert wird das nur von einem Menschen mit dem Handy in der Hand
			// (E10). Bis dahin einmal pro Stunde nachsehen.
			this.setConnected(false);
			state.nextDueAt = now + this.intervals.errorMs;
			this.log.error(`${error.message} - Polling auf einmal pro Stunde gedrosselt.`);
			return;
		}

		if (error.retryable && state.attempts < error.maxRetries) {
			state.attempts += 1;
			const waitMs = error.retryAfterMs ?? this.jitteredRetry();
			state.nextDueAt = now + waitMs;
			this.log.warn(`${error.message} - Versuch ${state.attempts} in ${Math.round(waitMs / 1000)} s.`);
			return;
		}

		state.attempts = 0;
		state.nextDueAt = now + this.intervalFor(state);
		this.log.warn(`${error.message} - naechster regulaerer Poll.`);
	}

	/**
	 * Merkt sich, welche Teile das Fahrzeug liefert, und was es dauerhaft nicht kann.
	 *
	 * Teile, die als `*_UNSUPPORTED` gemeldet werden, verschwinden dauerhaft aus der
	 * Liste - danach zu fragen kostet nur Antwortlaenge. `*_DISABLED` und
	 * `*_UNAVAILABLE` bleiben drin: Beides kann morgen wieder gehen.
	 *
	 * @param state Der Zustand des Fahrzeugs.
	 * @param response Die Antwort.
	 */
	private learnParts(state: VehicleState, response: VehicleResponse): void {
		const vehicle = response.vehicle as unknown as Record<string, unknown>;
		const known = new Set<VehiclePart>(state.parts ?? []);
		for (const part of detectParts(vehicle)) {
			known.add(part);
		}

		for (const error of vehicleErrors(response)) {
			const part = partFromErrorType(error.type);
			if (!part) {
				continue;
			}
			if (error.type.endsWith('_UNSUPPORTED')) {
				known.delete(part);
			} else {
				// Vorhanden, aber gerade nicht abrufbar: weiter anfordern.
				known.add(part);
			}
		}

		const learned = VEHICLE_PARTS.filter(part => known.has(part));
		if (state.parts === undefined) {
			this.log.info(`Fahrzeug ${maskVin(state.vin)} liefert: ${learned.join(', ')}`);
		}
		state.parts = learned;
	}

	/**
	 * Baut den `include`-Parameter des naechsten Polls.
	 *
	 * Der erste Poll geht ohne `include` hinaus - das ist die Faehigkeitserkennung
	 * (E13). Ist die Parkposition abgeschaltet, wird stattdessen von Anfang an eine
	 * Liste geschickt: abgeschaltet heisst nicht "wegwerfen", sondern "gar nicht erst
	 * anfordern" (E14).
	 *
	 * @param state Der Zustand des Fahrzeugs.
	 * @returns Die anzufordernden Teile, oder undefined fuer "alles, was du hast".
	 */
	private includeFor(state: VehicleState): VehiclePart[] | undefined {
		const base = state.parts ?? (this.readParkingPosition ? undefined : [...VEHICLE_PARTS]);
		if (!base) {
			return undefined;
		}
		const parts = this.readParkingPosition ? base : base.filter(part => part !== 'parkingPosition');
		return parts.length > 0 ? [...parts] : undefined;
	}

	/**
	 * Laedt oder klimatisiert das Fahrzeug gerade?
	 *
	 * Gemessen an denselben Werten, aus denen der Soll-Schalter seinen Ist-Zustand
	 * bildet - so kann die Kadenz nicht von der Anzeige abweichen.
	 *
	 * @param vehicle Die Fahrzeugdaten.
	 * @returns True, wenn in einer der Domaenen etwas laeuft.
	 */
	private isActive(vehicle: Record<string, unknown>): boolean {
		return COMMAND_DEFS.some(def => {
			const block = vehicle[def.part];
			if (typeof block !== 'object' || block === null) {
				return false;
			}
			let current: unknown = block;
			for (const key of def.statePath.split('.')) {
				if (typeof current !== 'object' || current === null) {
					return false;
				}
				current = (current as Record<string, unknown>)[key];
			}
			return typeof current === 'string' && def.activeStates.includes(current);
		});
	}

	/**
	 * Die Kadenz eines Fahrzeugs, Backoff eingerechnet.
	 *
	 * @param state Der Zustand des Fahrzeugs.
	 * @returns Das Intervall in Millisekunden.
	 */
	private intervalFor(state: VehicleState): number {
		const base = state.active || this.inCommandMode(state) ? this.intervals.activeMs : this.intervals.idleMs;
		return Math.min(base * state.backoff, this.intervals.backoffMaxMs);
	}

	/**
	 * Laeuft gerade das Fenster nach einem Befehl?
	 *
	 * @param state Der Zustand des Fahrzeugs.
	 * @returns True, solange die aktive Kadenz nach einem Befehl gilt.
	 */
	private inCommandMode(state: VehicleState): boolean {
		return state.commandModeUntil !== undefined && this.now() < state.commandModeUntil;
	}

	/**
	 * Wartezeit vor einer Wiederholung, mit Jitter.
	 *
	 * Ohne Jitter faellt eine Instanz nach einer Stoerung im selben Takt wieder auf
	 * denselben Server (E15).
	 *
	 * @returns Wartezeit in Millisekunden.
	 */
	private jitteredRetry(): number {
		return Math.round(this.intervals.retryMs * (0.5 + this.random()));
	}

	/**
	 * Meldet einen Wechsel des Verbindungszustands, aber nur einen echten.
	 *
	 * @param connected Ob die API erreichbar und der Schluessel gueltig ist.
	 */
	private setConnected(connected: boolean): void {
		if (this.connected === connected) {
			return;
		}
		this.connected = connected;
		this.onConnectionChange?.(connected);
	}

	/**
	 * Wartezeit bis zum naechsten faelligen Poll.
	 *
	 * @returns Millisekunden, mindestens eine Sekunde.
	 */
	private msUntilNextDue(): number {
		const now = this.now();
		let earliest: number | undefined;
		for (const state of this.states.values()) {
			if (state.suspended) {
				continue;
			}
			if (earliest === undefined || state.nextDueAt < earliest) {
				earliest = state.nextDueAt;
			}
		}
		if (earliest === undefined) {
			// Alle Fahrzeuge ausgesetzt: nicht auf der Stelle treten.
			return this.intervals.errorMs;
		}
		return Math.max(MIN_SLEEP_MS, earliest - now);
	}

	/** Setzt den Zeitgeber neu, wenn sich die naechste Faelligkeit vorgezogen hat. */
	private wake(): void {
		if (!this.running || this.tickTask) {
			return;
		}
		if (this.timer !== undefined) {
			this.clearTimer(this.timer);
			this.timer = undefined;
		}
		this.arm(this.msUntilNextDue());
	}

	/**
	 * Setzt den Zeitgeber fuer den naechsten Durchlauf.
	 *
	 * @param delayMs Wartezeit in Millisekunden.
	 */
	private arm(delayMs: number): void {
		if (this.timer !== undefined) {
			this.clearTimer(this.timer);
		}
		this.timer = this.setTimer(
			() => {
				void this.loop();
			},
			Math.max(0, delayMs),
		);
	}

	/** Ein Durchlauf der Schleife: faellige Polls ausfuehren, neu terminieren. */
	private async loop(): Promise<void> {
		this.timer = undefined;
		if (!this.running) {
			return;
		}
		try {
			await this.tick();
			if (this.running) {
				this.arm(this.msUntilNextDue());
			}
		} catch (error: unknown) {
			// Ein Fehler hier darf die Schleife nicht anhalten - sonst steht der
			// Adapter still, bis jemand die Instanz neu startet.
			this.log.error(`Unerwarteter Fehler im Poll-Durchlauf: ${String(error)}`);
			if (this.running) {
				this.arm(this.intervals.retryMs);
			}
		}
	}
}

/**
 * Kuerzt eine VIN fuer das Log auf ihre letzten vier Zeichen.
 *
 * Vollstaendig gehoert sie dort nicht hin (E14), ganz weglassen kann man sie bei
 * mehreren Fahrzeugen aber auch nicht.
 *
 * @param vin Fahrgestellnummer.
 * @returns Etwas wie `…9999`.
 */
function maskVin(vin: string): string {
	return `…${vin.slice(-4)}`;
}
