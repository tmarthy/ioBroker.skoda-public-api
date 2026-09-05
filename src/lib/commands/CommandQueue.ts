/**
 * CommandQueue - der Weg vom Schalter zum Fahrzeug.
 *
 * Ein Befehl kostet realistisch zwei bis drei Requests: den POST selbst und den
 * Verifikations-Poll, denn die API antwortet mit `202` und kennt keinen Endpunkt, der
 * den Ausgang meldet. Bei 20 Requests pro Stunde ist das der Grund, warum hier eine
 * Queue steht und kein direkter Aufruf:
 *
 * - **Idempotenz.** Soll gleich Ist heisst: gar nicht erst senden.
 * - **Coalescing.** Ein neuer Soll-Wert ersetzt den wartenden Eintrag derselben
 *   Domaene. Eine Bang-Bang-Regelung auf einer PV-Anlage schaltet bei jeder
 *   durchziehenden Wolke; gedaempft wird das an der einzigen Stelle, die das Budget
 *   kennt (E5).
 * - **TTL.** Was in zehn Minuten nicht rausging, will niemand mehr. Ist die Wartezeit
 *   aus `Retry-After` laenger als die Rest-TTL, verfaellt der Befehl sofort, statt
 *   Budget fuer eine Absicht auszugeben, die inzwischen ueberholt ist (E15).
 *
 * `ack: true` heisst hier **an die API uebergeben**, nicht "das Auto hat es getan" (E6).
 */
import type { ApiError } from '../api/errors';
import type { ApiMeta, ApiResult, CommandBody } from '../api/client';
import type { CommandAction, CommandDomain, VehicleResponse } from '../api/types';
import { newestCapturedAt } from '../api/vehicleData';
import type { VehicleQuota } from '../quota/VehicleQuotaManager';
import { COMMAND_DEFS, type CommandDomainDef, type CommandReport, type CommandResult } from '../states/commandDefs';
import { buildCommandBody, parseCommandState, type ParsedCommand } from './commandMap';

/** Der Ausschnitt des Clients, den die Queue braucht. */
export interface CommandSender {
	/** Setzt einen Befehl ab; `ok: true` heisst `202 Accepted`. */
	sendCommand(
		vin: string,
		domain: CommandDomain,
		action: CommandAction,
		body?: CommandBody,
	): Promise<ApiResult<void>>;
}

/** Die Logstufen, die die Queue benutzt. */
export interface CommandLog {
	/** Einzelheiten der Warteschlange. */
	debug(message: string): void;
	/** Was ein Nutzer im Log sehen soll: abgesetzte und verworfene Befehle. */
	info(message: string): void;
	/** Stoerungen, die von selbst vorbeigehen. */
	warn(message: string): void;
	/** Stoerungen, die einen Menschen brauchen. */
	error(message: string): void;
}

/** Ein Zeitgeber-Handle; der Adapter reicht seinen eigenen herein. */
export type TimerHandle = unknown;

/** Womit die Queue eingerichtet wird. */
export interface CommandQueueOptions {
	/** Die HTTP-Schicht. */
	client: CommandSender;
	/** Ohne Zustimmung des Budgets geht kein Befehl hinaus. */
	quota: VehicleQuota;
	/** Die konfigurierten Fahrzeuge; alles andere wird ignoriert. */
	vins: readonly string[];
	/** Wohin das Ergebnis geht - in Phase 7 der StateWriter. */
	onReport: (vin: string, report: CommandReport) => Promise<void> | void;
	/** Wohin die Meldungen gehen. */
	log: CommandLog;
	/** Wird nach einem abgesetzten Befehl gerufen: Verifikations-Poll (Phase 6). */
	onCommandSent?: (vin: string) => void;
	/** Meldet `info.connection`, wenn der Schluessel abgelehnt wird (E10). */
	onConnectionChange?: (connected: boolean) => void;
	/** Wird nach jeder Antwort gerufen - daran haengt der Schluesselablauf (E10). */
	onResponse?: (meta: ApiMeta, error?: ApiError) => void;
	/** Lebensdauer eines wartenden Befehls. */
	ttlMs?: number;
	/** S-PIN aus der Instanzkonfiguration, niemals aus einem State. */
	spin?: string;
	/** Grundwartezeit vor einer Wiederholung; sie bekommt Jitter. */
	retryMs?: number;
	/** Zeitquelle, ersetzbar fuer Tests. */
	now?: () => number;
	/** Zufall fuer den Jitter, ersetzbar fuer Tests. */
	random?: () => number;
	/** Zeitgeber; der Adapter reicht `setTimeout` seiner Instanz herein. */
	setTimer?: (handler: () => void, ms: number) => TimerHandle;
	/** Gegenstueck zu `setTimer`. */
	clearTimer?: (handle: TimerHandle) => void;
}

/** Vorgabe der Lebensdauer eines Befehls (E5). */
export const DEFAULT_TTL_MS = 10 * 60_000;

/** Ein wartender Befehl. */
interface QueueEntry {
	command: ParsedCommand;
	expiresAt: number;
	/** Fruehester naechster Versuch. */
	notBefore: number;
	attempts: number;
	/** Ob dem Nutzer schon gemeldet wurde, dass gewartet wird. */
	queuedReported: boolean;
	/** Kostenpflichtige Wiederholungen duerfen die Befehlsreserve nicht aufbrauchen. */
	protectReserve: boolean;
}

/**
 * Nimmt Schreibvorgaenge auf den Befehls-States entgegen und setzt sie ab, sobald
 * Budget da ist.
 */
export class CommandQueue {
	private readonly client: CommandSender;
	private readonly quota: VehicleQuota;
	private readonly vins: Set<string>;
	private readonly onReport: CommandQueueOptions['onReport'];
	private readonly onCommandSent?: (vin: string) => void;
	private readonly onConnectionChange?: (connected: boolean) => void;
	private readonly onResponse?: (meta: ApiMeta, error?: ApiError) => void;
	private readonly log: CommandLog;
	private readonly ttlMs: number;
	private readonly spin?: string;
	private readonly retryMs: number;
	private readonly now: () => number;
	private readonly random: () => number;
	private readonly setTimer: (handler: () => void, ms: number) => TimerHandle;
	private readonly clearTimer: (handle: TimerHandle) => void;

	/** Ein wartender Eintrag je Fahrzeug und Domaene - der Schluessel des Coalescings. */
	private readonly entries = new Map<string, QueueEntry>();
	/** Die zuletzt gepollten Bloecke je Fahrzeug, fuer Ist-Vergleich und Koerperbau. */
	private readonly blocks = new Map<string, Map<string, Record<string, unknown>>>();
	/** Domaenen, die das Fahrzeug dauerhaft nicht kann (422 operation-not-supported). */
	private readonly unsupported = new Set<string>();
	/** Sollwerte der Requests, die gerade unterwegs sind. */
	private readonly inFlight = new Map<string, boolean>();
	/** Akzeptierte Sollwerte, die noch kein Poll bestaetigt hat. */
	private readonly awaitingState = new Map<string, { desired: boolean; sentAt: number; expiresAt: number }>();

	/** Serialisiert die Durchlaeufe: Zwei gleichzeitige Sendungen waeren ein Leck. */
	private chain: Promise<void> = Promise.resolve();
	private running = false;
	private timer?: TimerHandle;

	/**
	 * @param options Client, Budget, Fahrzeuge, Ausgabekanaele und Zeitwerte.
	 */
	public constructor(options: CommandQueueOptions) {
		this.client = options.client;
		this.quota = options.quota;
		this.vins = new Set(options.vins);
		this.onReport = options.onReport;
		this.onCommandSent = options.onCommandSent;
		this.onConnectionChange = options.onConnectionChange;
		this.onResponse = options.onResponse;
		this.log = options.log;
		this.ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
		this.spin = options.spin;
		this.retryMs = options.retryMs ?? 15_000;
		this.now = options.now ?? (() => Date.now());
		this.random = options.random ?? Math.random;
		this.setTimer = options.setTimer ?? ((handler, ms) => globalThis.setTimeout(handler, ms));
		this.clearTimer = options.clearTimer ?? (handle => globalThis.clearTimeout(handle as NodeJS.Timeout));
	}

	/** Startet die Schleife fuer wartende Befehle. */
	public start(): void {
		this.running = true;
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
	 * Uebernimmt die zuletzt gepollten Daten.
	 *
	 * Daraus kommt der Ist-Zustand fuer die Idempotenz und der Koerper fuer
	 * `air-conditioning/start` - beides also aus derselben Quelle, die auch die
	 * Zustaende speist.
	 *
	 * @param vin Fahrgestellnummer.
	 * @param response Die Antwort eines Polls.
	 */
	public updateFromResponse(vin: string, response: VehicleResponse): void {
		const vehicle = response.vehicle as unknown as Record<string, unknown>;
		const blocks = this.blocks.get(vin) ?? new Map<string, Record<string, unknown>>();
		for (const def of COMMAND_DEFS) {
			const block = vehicle[def.part];
			if (block !== null && typeof block === 'object') {
				const typedBlock = block as Record<string, unknown>;
				blocks.set(def.part, typedBlock);
				const key = this.keyOf({ vin, def });
				const expected = this.awaitingState.get(key);
				const captured = newestCapturedAt(typedBlock);
				if (
					expected &&
					captured !== undefined &&
					captured > expected.sentAt &&
					this.activeFromBlock(def, typedBlock) === expected.desired
				) {
					this.awaitingState.delete(key);
				}
			}
		}
		this.blocks.set(vin, blocks);
	}

	/**
	 * Nimmt einen Schreibvorgang auf einem Befehls-State entgegen.
	 *
	 * @param relativeId ID ohne Namensraum, z.B. `TMBJB9NY5RF999999.charging.enabled`.
	 * @param value Der geschriebene Wert.
	 * @returns Nichts; das Ergebnis geht ueber `onReport` hinaus.
	 */
	public async submit(relativeId: string, value: unknown): Promise<void> {
		const command = parseCommandState(relativeId, value);
		if (!command || !this.vins.has(command.vin)) {
			return;
		}

		const key = this.keyOf(command);

		if (this.unsupported.has(key)) {
			this.log.warn(`${command.name}: Das Fahrzeug unterstuetzt diesen Befehl nicht.`);
			await this.report(command, 'REJECTED_BY_VEHICLE');
			return;
		}

		// Idempotenz und Coalescing in einem: Entspricht der Soll dem Ist, faellt ein
		// wartender Eintrag ersatzlos weg und es geht kein Request hinaus (E5).
		// Vom Beginn des Requests bis zu einem bestaetigenden Poll ist der gepufferte
		// Ist-Zustand zu alt fuer die Idempotenz. In diesem Fenster gilt der zuletzt
		// gesendete Sollwert: derselbe Wunsch ist redundant, ein Gegenwunsch muss warten.
		const waiting = this.awaitingState.get(key);
		if (waiting && this.now() >= waiting.expiresAt) {
			this.awaitingState.delete(key);
			const block = this.blocks.get(command.vin)?.get(command.def.part);
			// Ohne neuere Daten ist der Ist unbekannt, nicht wieder der Wert vor dem POST.
			if (!block || (newestCapturedAt(block) ?? -Infinity) <= waiting.sentAt) {
				this.blocks.get(command.vin)?.delete(command.def.part);
			}
		}
		const unsettledDesired = this.inFlight.get(key) ?? this.awaitingState.get(key)?.desired;
		const alreadyDesired =
			unsettledDesired !== undefined
				? unsettledDesired === command.desired
				: this.isActive(command) === command.desired;
		if (command.viaSwitch && alreadyDesired) {
			if (this.entries.delete(key)) {
				this.log.debug(`${command.name}: wartender Befehl verfaellt, Soll entspricht dem Ist.`);
			}
			await this.report(command, 'COALESCED');
			return;
		}

		if (this.entries.has(key)) {
			this.log.debug(`${command.name}: ersetzt den wartenden Befehl derselben Domaene.`);
		}
		const now = this.now();
		this.entries.set(key, {
			command,
			expiresAt: now + this.ttlMs,
			notBefore: now,
			attempts: 0,
			queuedReported: false,
			protectReserve: false,
		});

		await this.pump();
	}

	/**
	 * Arbeitet die Warteschlange ab, soweit sie faellig ist.
	 *
	 * Oeffentlich, damit Tests die Zeit selbst fuehren koennen.
	 *
	 * @returns Millisekunden bis zum naechsten Versuch, oder undefined wenn nichts wartet.
	 */
	public async tick(): Promise<number | undefined> {
		for (const [key, entry] of [...this.entries]) {
			// Ein vorheriger await in diesem Durchlauf kann dem Event-Handler Zeit
			// gegeben haben, denselben Schluessel durch einen neueren Befehl zu ersetzen.
			if (this.entries.get(key) !== entry) {
				continue;
			}
			const now = this.now();
			if (now >= entry.expiresAt) {
				this.entries.delete(key);
				this.log.info(`${entry.command.name}: verfallen, nicht innerhalb der Lebensdauer absetzbar.`);
				await this.report(entry.command, 'EXPIRED');
				continue;
			}
			if (now < entry.notBefore) {
				continue;
			}
			await this.attempt(key, entry);
		}
		return this.msUntilNext();
	}

	/** Wie viele Befehle gerade warten - fuer Tests und Logausgaben. */
	public get pending(): number {
		return this.entries.size;
	}

	/**
	 * Fuehrt einen Durchlauf aus und terminiert den naechsten.
	 *
	 * Die Durchlaeufe sind serialisiert: Zwei gleichzeitige Sendungen wuerden zweimal
	 * Budget ziehen und zweimal dasselbe Fahrzeug ansprechen.
	 *
	 * @returns Nichts.
	 */
	private pump(): Promise<void> {
		this.chain = this.chain
			.then(async () => {
				const next = await this.tick();
				this.arm(next);
			})
			.catch(() => {
				// Eine abgewiesene Promise darf die serielle Kette nicht dauerhaft
				// vergiften. Der konkrete Client liefert Fehler als ApiResult; hier landen
				// nur unerwartete Fehler aus einem Port oder Callback.
				this.log.error(
					'Unerwarteter Fehler in der Befehlswarteschlange; der naechste Versuch wird verzoegert.',
				);
				const next = this.msUntilNext();
				this.arm(next === undefined ? undefined : Math.max(this.retryMs, next));
			});
		return this.chain;
	}

	/**
	 * Setzt den Zeitgeber fuer den naechsten Durchlauf.
	 *
	 * @param delayMs Wartezeit, oder undefined wenn nichts mehr wartet.
	 */
	private arm(delayMs: number | undefined): void {
		if (this.timer !== undefined) {
			this.clearTimer(this.timer);
			this.timer = undefined;
		}
		if (!this.running || delayMs === undefined) {
			return;
		}
		this.timer = this.setTimer(
			() => {
				this.timer = undefined;
				void this.pump();
			},
			Math.max(0, delayMs),
		);
	}

	/**
	 * Versucht, einen Befehl abzusetzen.
	 *
	 * @param key Schluessel des Eintrags.
	 * @param entry Der wartende Befehl.
	 */
	private async attempt(key: string, entry: QueueEntry): Promise<void> {
		if (this.entries.get(key) !== entry) {
			return;
		}
		const { command } = entry;
		const { body, problem } = buildCommandBody(command, {
			block: this.blocks.get(command.vin)?.get(command.def.part),
			spin: this.spin,
		});
		if (problem) {
			this.entries.delete(key);
			this.log.error(`${command.name}: ${problem}`);
			await this.report(command, 'FAILED');
			return;
		}

		const permission = this.quota.tryAcquire(command.vin, entry.protectReserve ? 'poll' : 'command');
		if ('reason' in permission) {
			const now = this.now();
			if (now + permission.waitMs >= entry.expiresAt) {
				// Warten waere laenger als die Lebensdauer: Dann lieber jetzt ehrlich
				// verwerfen als in zehn Minuten (E15).
				this.entries.delete(key);
				this.log.info(
					`${command.name}: verworfen, das Budget oeffnet sich erst in ` +
						`${Math.round(permission.waitMs / 60_000)} min.`,
				);
				await this.report(command, 'EXPIRED');
				return;
			}
			entry.notBefore = now + permission.waitMs;
			if (!entry.queuedReported) {
				entry.queuedReported = true;
				this.log.info(
					`${command.name}: wartet auf Budget (${permission.reason}), ` +
						`naechster Versuch in ${Math.round(permission.waitMs / 1000)} s.`,
				);
				await this.report(command, 'QUEUED');
			}
			return;
		}

		// Ab jetzt ist dieser Eintrag nicht mehr wartend. Ein neuer Schreibvorgang
		// derselben Domaene bekommt dadurch einen eigenen Eintrag und kann von der
		// spaeter eintreffenden Antwort dieses Requests nicht geloescht werden.
		this.entries.delete(key);
		this.inFlight.set(key, command.desired);
		let result: ApiResult<void>;
		try {
			result = await this.client.sendCommand(command.vin, command.def.domain, command.action, body);
		} finally {
			this.inFlight.delete(key);
		}
		this.quota.recordResponse(command.vin, result.meta, permission);
		this.onResponse?.(result.meta, result.ok ? undefined : result.error);

		if (result.ok) {
			this.awaitingState.set(key, {
				desired: command.desired,
				sentAt: this.now(),
				expiresAt: this.now() + this.ttlMs,
			});
			this.log.info(`${command.name}: an die API uebergeben.`);
			// Die Verifikation gehoert zum Request-Lebenslauf und darf nicht davon
			// abhaengen, ob das anschliessende Schreiben des Reports gelingt.
			this.onCommandSent?.(command.vin);
			await this.report(command, 'SENT', undefined, {
				path: command.statePath,
				// Der Knopf faellt zurueck, der Schalter behaelt den Soll-Zustand.
				value: command.viaSwitch ? command.desired : false,
			});
			return;
		}

		await this.handleError(key, entry, result.error);
	}

	/**
	 * Entscheidet nach der Fehlertabelle, was aus einem gescheiterten Befehl wird.
	 *
	 * @param key Schluessel des Eintrags.
	 * @param entry Der wartende Befehl.
	 * @param error Der Fehler aus dem Client.
	 */
	private async handleError(key: string, entry: QueueEntry, error: ApiError): Promise<void> {
		const { command } = entry;

		if (error.kind === 'operation-not-supported') {
			// Dauerhaft merken: Diese Faehigkeit bekommt das Fahrzeug nicht mehr (E15).
			this.unsupported.add(key);
			this.log.error(`${command.name}: ${error.message}`);
			await this.report(command, 'REJECTED_BY_VEHICLE', error.problemType);
			const replacement = this.entries.get(key);
			if (replacement) {
				this.entries.delete(key);
				await this.report(replacement.command, 'REJECTED_BY_VEHICLE', error.problemType);
			}
			return;
		}

		if (error.kind === 'operation-disabled' || error.kind === 'operation-not-authorized') {
			this.log.warn(`${command.name}: ${error.message}`);
			await this.report(command, 'REJECTED_BY_VEHICLE', error.problemType);
			return;
		}

		if (error.kind === 'api-key-expired' || error.kind === 'api-key-not-authorized') {
			this.onConnectionChange?.(false);
			this.log.error(`${command.name}: ${error.message}`);
			await this.report(command, 'FAILED', error.problemType);
			return;
		}

		if (error.retryable && entry.attempts < error.maxRetries) {
			if (this.entries.has(key)) {
				// Ein neuerer Befehl derselben Domaene wartet bereits. Die alte Absicht
				// darf nach einem Retry nicht wieder vor sie gesetzt werden.
				this.log.debug(`${command.name}: Wiederholung entfaellt zugunsten eines neueren Befehls.`);
				return;
			}
			const now = this.now();
			const waitMs = error.retryAfterMs ?? this.jitteredRetry();
			if (now + waitMs >= entry.expiresAt) {
				this.entries.delete(key);
				this.log.info(
					`${command.name}: verworfen, die Wartezeit von ${Math.round(waitMs / 60_000)} min ` +
						'ist laenger als seine Lebensdauer.',
				);
				await this.report(command, 'EXPIRED', error.problemType);
				return;
			}
			entry.attempts += 1;
			entry.protectReserve = error.consumesQuota;
			entry.notBefore = now + waitMs;
			this.entries.set(key, entry);
			this.log.warn(
				`${command.name}: ${error.message} - Versuch ${entry.attempts} in ${Math.round(waitMs / 1000)} s.`,
			);
			if (!entry.queuedReported) {
				entry.queuedReported = true;
				await this.report(command, 'QUEUED', error.problemType);
			}
			return;
		}

		this.log.error(`${command.name}: ${error.message}`);
		await this.report(
			command,
			error.kind === 'vehicle-not-accepting-requests' ? 'REJECTED_BY_VEHICLE' : 'FAILED',
			error.problemType,
		);
	}

	/**
	 * Meldet das Ergebnis nach oben.
	 *
	 * @param command Der Befehl.
	 * @param result Wie er ausgegangen ist.
	 * @param problemType Problemtyp der API, sofern einer kam.
	 * @param acknowledge Der zu quittierende Zustand.
	 */
	private async report(
		command: ParsedCommand,
		result: CommandResult,
		problemType?: string,
		acknowledge?: CommandReport['acknowledge'],
	): Promise<void> {
		try {
			await this.onReport(command.vin, {
				name: command.name,
				result,
				timestamp: this.now(),
				problemType,
				acknowledge,
			});
		} catch {
			// Fehlertexte des State-Backends koennen die volle State-ID und damit die
			// VIN enthalten. Deshalb nur eine eigene, maskierungsfreie Meldung loggen.
			this.log.error(`${command.name}: Ergebnis konnte nicht in ioBroker-Zustaende geschrieben werden.`);
		}
	}

	/**
	 * Der Ist-Zustand einer Domaene aus dem letzten Poll.
	 *
	 * @param command Der Befehl.
	 * @returns True oder false, oder undefined solange nichts gepollt wurde.
	 */
	private isActive(command: ParsedCommand): boolean | undefined {
		const block = this.blocks.get(command.vin)?.get(command.def.part);
		if (!block) {
			return undefined;
		}
		return this.activeFromBlock(command.def, block);
	}

	/**
	 * Liest den Ist-Zustand aus einem bereits gefundenen Antwortblock.
	 *
	 * @param def Domaene samt Pfad und aktiven Werten.
	 * @param block Der Antwortblock dieser Domaene.
	 * @returns True oder false, oder undefined bei unvollstaendigen Daten.
	 */
	private activeFromBlock(def: CommandDomainDef, block: Record<string, unknown>): boolean | undefined {
		let current: unknown = block;
		for (const part of def.statePath.split('.')) {
			if (typeof current !== 'object' || current === null) {
				return undefined;
			}
			current = (current as Record<string, unknown>)[part];
		}
		return typeof current === 'string' ? def.activeStates.includes(current) : undefined;
	}

	/**
	 * Schluessel eines Eintrags: ein wartender Befehl je Fahrzeug und Domaene.
	 *
	 * @param command Der Befehl.
	 * @returns Der Schluessel.
	 */
	private keyOf(command: ParsedCommand | { vin: string; def: CommandDomainDef }): string {
		return `${command.vin}|${command.def.part}`;
	}

	/**
	 * Wartezeit vor einer Wiederholung, mit Jitter (E15).
	 *
	 * @returns Wartezeit in Millisekunden.
	 */
	private jitteredRetry(): number {
		return Math.round(this.retryMs * (0.5 + this.random()));
	}

	/**
	 * Wann der naechste Versuch faellig ist.
	 *
	 * @returns Millisekunden, oder undefined wenn nichts wartet.
	 */
	private msUntilNext(): number | undefined {
		let earliest: number | undefined;
		for (const entry of this.entries.values()) {
			const due = Math.min(entry.notBefore, entry.expiresAt);
			if (earliest === undefined || due < earliest) {
				earliest = due;
			}
		}
		return earliest === undefined ? undefined : Math.max(0, earliest - this.now());
	}
}
