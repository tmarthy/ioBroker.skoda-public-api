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
import { ShutdownError } from '../lifecycle';
import type { ApiError } from '../api/errors';
import { vehicleErrors, type ApiMeta, type ApiResult, type CommandBody } from '../api/client';
import { partFromErrorType } from '../api/parts';
import type { CommandAction, CommandDomain, VehicleResponse } from '../api/types';
import { newestCapturedAt } from '../api/vehicleData';
import type { VehicleQuota } from '../quota/VehicleQuotaManager';
import {
	CHARGING_LIMIT_DEF,
	CHARGING_MODE_DEF,
	chargingProfileDef,
	COMMAND_DEFS,
	type CommandDomainDef,
	type CommandReport,
	type CommandResult,
} from '../states/commandDefs';
import { buildCommandBody, parseCommandState, type ParsedCommand } from './commandMap';
import { canonicalJson, findProfile, isProfileId, isRecord } from './chargingControls';
import { translateFallback, type Translate } from '../i18n';
import type { CommandConfirmation, ConfirmationStatus } from './confirmation';

/** Der Ausschnitt des Clients, den die Queue braucht. */
export interface CommandSender {
	/** Cancels outstanding HTTP activity. */
	abort?(): void;
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
	/** Wohin das Ergebnis geht: in der Adapterverdrahtung der StateWriter. */
	onReport: (vin: string, report: CommandReport) => Promise<void> | void;
	/** Observation-only notification; never schedules a request or retries a command. */
	onConfirmation?: (vin: string, confirmation: CommandConfirmation) => void;
	/** Wohin die Meldungen gehen. */
	log: CommandLog;
	/** Backend-Uebersetzung; ohne Adapter-Kontext wird Englisch verwendet. */
	t?: Translate;
	/** Wird nach einem abgesetzten Befehl gerufen: Verifikations-Poll des Schedulers. */
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

/** Retained after timeout so existing coalescing can invalidate stale pre-command data. */
interface AwaitingConfirmation {
	command: ParsedCommand;
	desired: boolean | number | string;
	sentAt: number;
	expiresAt: number;
	timedOut?: boolean;
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
	private readonly onConfirmation?: CommandQueueOptions['onConfirmation'];
	private readonly onCommandSent?: (vin: string) => void;
	private readonly onConnectionChange?: (connected: boolean) => void;
	private readonly onResponse?: (meta: ApiMeta, error?: ApiError) => void;
	private readonly log: CommandLog;
	private readonly t: Translate;
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
	private readonly inFlight = new Map<string, boolean | number | string>();
	/** Akzeptierte Sollwerte, die noch kein Poll bestaetigt hat. */
	private readonly awaitingState = new Map<string, AwaitingConfirmation>();

	/** Admitted submissions, including immediate reports outside the send chain. */
	private readonly submissions = new Set<Promise<void>>();
	/** Serialisiert die Durchlaeufe: Zwei gleichzeitige Sendungen waeren ein Leck. */
	private chain: Promise<void> = Promise.resolve();
	private tickTask?: Promise<number | undefined>;
	private running = false;
	private stopped = false;
	private timer?: TimerHandle;
	/** Separate from the sending timer: expiry may only update local diagnostics. */
	private confirmationTimer?: TimerHandle;

	/**
	 * @param options Client, Budget, Fahrzeuge, Ausgabekanaele und Zeitwerte.
	 */
	public constructor(options: CommandQueueOptions) {
		this.client = options.client;
		this.quota = options.quota;
		this.vins = new Set(options.vins);
		this.onReport = options.onReport;
		this.onConfirmation = options.onConfirmation;
		this.onCommandSent = options.onCommandSent;
		this.onConnectionChange = options.onConnectionChange;
		this.onResponse = options.onResponse;
		this.log = options.log;
		this.t = options.t ?? translateFallback;
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
		if (this.stopped) {
			return;
		}
		this.running = true;
		this.armConfirmationTimer();
	}

	/** Haelt die Schleife an. Muss beim Entladen des Adapters gerufen werden. */
	public stop(): void {
		this.stopped = true;
		this.running = false;
		if (this.timer !== undefined) {
			this.clearTimer(this.timer);
			this.timer = undefined;
		}
		if (this.confirmationTimer !== undefined) {
			this.clearTimer(this.confirmationTimer);
			this.confirmationTimer = undefined;
		}
		this.awaitingState.clear();
		this.client.abort?.();
		this.entries.clear();
	}

	/** Stops permanently and drains active work. Restart uses a fresh component. */
	public async shutdown(): Promise<void> {
		this.stop();
		await Promise.all([this.chain, this.tickTask, ...this.submissions]);
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
		if (this.stopped) {
			return;
		}
		this.expireConfirmations();
		const failedParts = new Set<string | undefined>(
			vehicleErrors(response).map(error => partFromErrorType(error.type)),
		);
		const vehicle = response.vehicle as unknown as Record<string, unknown>;
		const blocks = this.blocks.get(vin) ?? new Map<string, Record<string, unknown>>();
		// An omitted or removed profile must not remain a writable cached snapshot.
		blocks.delete('chargingProfiles');
		const profileBlock = vehicle.chargingProfiles;
		const profiles = isRecord(profileBlock) && Array.isArray(profileBlock.profiles) ? profileBlock.profiles : [];
		const profileDefs = profiles
			.filter(profile => isRecord(profile) && isProfileId(profile.id))
			.map(profile => chargingProfileDef(profile.id as number));
		if (isRecord(profileBlock)) {
			blocks.set('chargingProfiles', profileBlock);
		}
		for (const def of [...COMMAND_DEFS, CHARGING_LIMIT_DEF, CHARGING_MODE_DEF, ...profileDefs]) {
			const block = vehicle[def.part];
			if (block !== null && typeof block === 'object') {
				const typedBlock = block as Record<string, unknown>;
				blocks.set(def.part, typedBlock);
				const key = this.keyOf({ vin, def });
				const expected = this.awaitingState.get(key);
				// Only this response block can confirm its command; unrelated nested timestamps cannot.
				const captured =
					typeof typedBlock.carCapturedTimestamp === 'string'
						? Date.parse(typedBlock.carCapturedTimestamp)
						: NaN;
				if (
					expected &&
					!failedParts.has(def.part) &&
					Number.isFinite(captured) &&
					captured > expected.sentAt &&
					this.confirmationMatches(expected, typedBlock)
				) {
					this.awaitingState.delete(key);
					if (!expected.timedOut) {
						this.publishConfirmation(expected, 'CONFIRMED');
					}
				}
			}
		}
		this.blocks.set(vin, blocks);
		this.armConfirmationTimer();
	}

	/**
	 * Nimmt einen Schreibvorgang auf einem Befehls-State entgegen.
	 *
	 * @param relativeId ID ohne Namensraum, z.B. `TMBJB9NY5RF999999.charging.enabled`.
	 * @param value Der geschriebene Wert.
	 * @param profileBase Original editor snapshot for conflict detection.
	 * @returns Nichts; das Ergebnis geht ueber `onReport` hinaus.
	 */
	public submit(relativeId: string, value: unknown, profileBase?: string): Promise<void> {
		if (this.stopped) {
			return Promise.resolve();
		}
		const task = this.runSubmit(relativeId, value, profileBase);
		this.submissions.add(task);
		void task.then(
			() => this.submissions.delete(task),
			() => this.submissions.delete(task),
		);
		return task;
	}

	/**
	 * Processes one admitted submission, including immediate reports.
	 *
	 * @param relativeId Relative command state ID.
	 * @param value Requested state value.
	 * @param profileBase Original editor snapshot for conflict detection.
	 */
	private async runSubmit(relativeId: string, value: unknown, profileBase?: string): Promise<void> {
		if (this.stopped) {
			return;
		}
		this.expireConfirmations();
		const command = parseCommandState(relativeId, value);
		if (!command || !this.vins.has(command.vin)) {
			return;
		}

		if (command.action === 'profile') {
			command.profileBase = profileBase;
		}
		const block = this.blocks.get(command.vin)?.get(command.def.part);
		const validation = buildCommandBody(command, { spin: this.spin, block });
		if ((command.action === 'limit' || command.def.setting) && validation.problem) {
			this.log.warn(validation.problem);
			await this.report(command, 'FAILED');
			return;
		}

		if (command.action === 'profile') {
			command.profileBase = canonicalJson(findProfile(block, command.def.profileId!));
		}

		const key = this.keyOf(command);
		const pendingEntry = this.entries.get(key);
		const awaiting = this.awaitingState.get(key);
		const pendingProfile =
			(pendingEntry && pendingEntry.expiresAt > this.now() ? pendingEntry.command.desired : undefined) ??
			this.inFlight.get(key) ??
			(awaiting && awaiting.expiresAt > this.now() ? awaiting.desired : undefined);
		if (profileBase !== undefined && pendingProfile !== undefined && pendingProfile !== command.desired) {
			this.log.warn('Another profile update is pending. Wait for fresh vehicle data before applying this draft.');
			await this.report(command, 'FAILED');
			return;
		}

		if (this.unsupported.has(key)) {
			this.log.warn(this.t('%s: The vehicle does not support this command.', command.name));
			await this.report(command, 'REJECTED_BY_VEHICLE');
			return;
		}

		// Idempotenz und Coalescing in einem: Entspricht der Soll dem Ist, faellt ein
		// wartender Eintrag ersatzlos weg und es geht kein Request hinaus (E5).
		// Vom Beginn des Requests bis zu einem bestaetigenden Poll ist der gepufferte
		// Ist-Zustand zu alt fuer die Idempotenz. In diesem Fenster gilt der zuletzt
		// gesendete Sollwert: derselbe Wunsch ist redundant, ein Gegenwunsch muss warten.
		const waiting = this.awaitingState.get(key);
		let ignoreReported = false;
		if (waiting && this.now() >= waiting.expiresAt) {
			this.awaitingState.delete(key);
			const block = this.blocks.get(command.vin)?.get(command.def.part);
			// Ohne neuere Daten ist der Ist unbekannt, nicht wieder der Wert vor dem POST.
			if (!block || (newestCapturedAt(block) ?? -Infinity) <= waiting.sentAt) {
				if (command.def.setting) {
					// Retain the profile snapshot / advertised modes needed to validate a retry.
					ignoreReported = true;
				} else {
					this.blocks.get(command.vin)?.delete(command.def.part);
				}
			}
		}
		const unsettledDesired = this.inFlight.get(key) ?? this.awaitingState.get(key)?.desired;
		const alreadyDesired =
			unsettledDesired !== undefined
				? unsettledDesired === command.desired
				: !ignoreReported && this.currentValue(command) === command.desired;
		if (command.viaSwitch && alreadyDesired) {
			if (this.entries.delete(key)) {
				this.log.debug(
					this.t('%s: Pending command dropped because the target state is already reached.', command.name),
				);
			}
			await this.report(
				command,
				'COALESCED',
				undefined,
				(command.action === 'limit' || command.def.setting) && !this.inFlight.has(key)
					? { path: command.statePath, value: command.desired }
					: undefined,
			);
			return;
		}

		if (this.entries.has(key)) {
			this.log.debug(this.t('%s: Replaced the pending command for the same domain.', command.name));
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
	public tick(): Promise<number | undefined> {
		if (this.stopped) {
			return Promise.resolve(undefined);
		}
		this.tickTask ??= this.runTick().finally(() => {
			this.tickTask = undefined;
		});
		return this.tickTask;
	}

	/** Processes a single serialized batch. */
	private async runTick(): Promise<number | undefined> {
		this.expireConfirmations();
		for (const [key, entry] of [...this.entries]) {
			if (this.stopped) {
				break;
			}
			// Ein vorheriger await in diesem Durchlauf kann dem Event-Handler Zeit
			// gegeben haben, denselben Schluessel durch einen neueren Befehl zu ersetzen.
			if (this.entries.get(key) !== entry) {
				continue;
			}
			const now = this.now();
			if (now >= entry.expiresAt) {
				this.entries.delete(key);
				this.log.info(
					this.t('%s: Expired because it could not be sent within its lifetime.', entry.command.name),
				);
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
			.catch(error => {
				if (this.stopped || error instanceof ShutdownError) {
					return;
				}
				// Eine abgewiesene Promise darf die serielle Kette nicht dauerhaft
				// vergiften. Der konkrete Client liefert Fehler als ApiResult; hier landen
				// nur unerwartete Fehler aus einem Port oder Callback.
				this.log.error(this.t('Unexpected error in the command queue; the next attempt will be delayed.'));
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
			this.log.error(this.t('%s: %s', command.name, this.t(problem)));
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
					this.t(
						'%s: Dropped because quota becomes available only in %s min.',
						command.name,
						Math.round(permission.waitMs / 60_000),
					),
				);
				await this.report(command, 'EXPIRED');
				return;
			}
			entry.notBefore = now + permission.waitMs;
			if (!entry.queuedReported) {
				entry.queuedReported = true;
				this.log.info(
					this.t(
						'%s: Waiting for quota (%s), next attempt in %s s.',
						command.name,
						permission.reason,
						Math.round(permission.waitMs / 1000),
					),
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
		} catch (error) {
			if (this.stopped || error instanceof ShutdownError) {
				return;
			}
			throw error;
		} finally {
			this.inFlight.delete(key);
		}
		if (this.stopped) {
			return;
		}
		this.quota.recordResponse(command.vin, result.meta, permission);
		this.onResponse?.(result.meta, result.ok ? undefined : result.error);
		if (this.stopped) {
			return;
		}

		if (result.ok) {
			const accepted: AwaitingConfirmation = {
				command,
				desired: command.desired,
				sentAt: this.now(),
				expiresAt: this.now() + this.ttlMs,
			};
			this.awaitingState.set(key, accepted);
			this.publishConfirmation(accepted, 'WAITING');
			this.armConfirmationTimer();
			this.log.info(this.t('%s: Sent to the API.', command.name));
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
	 * Unknown states cannot prove that a stop command took effect.
	 *
	 * @param expected Accepted command.
	 * @param block Its vehicle response block.
	 */
	private confirmationMatches(expected: AwaitingConfirmation, block: Record<string, unknown>): boolean {
		const def = expected.command.def;
		if (this.valueFromBlock(def, block) !== expected.desired) {
			return false;
		}
		if (expected.desired !== false || def.numeric || def.setting) {
			return true;
		}
		const state = def.part === 'charging' && isRecord(block.status) ? block.status.state : block.state;
		const inactive =
			def.part === 'charging'
				? ['CONNECT_CABLE', 'CONSERVING', 'READY_FOR_CHARGING', 'DISCHARGING', 'CHARGING_INTERRUPTED']
				: def.part === 'airConditioning'
					? ['OFF', 'COMPLETED']
					: ['OFF'];
		return typeof state === 'string' && inactive.includes(state);
	}

	/**
	 * Publish a fresh snapshot; callback failure must not change command processing.
	 *
	 * @param expected Accepted command.
	 * @param status Observation outcome.
	 */
	private publishConfirmation(expected: AwaitingConfirmation, status: ConfirmationStatus): void {
		if (this.stopped) {
			return;
		}
		const { command } = expected;
		const def = command.def;
		const channel = def.numeric
			? 'chargingLimit'
			: def.setting === 'mode'
				? 'chargingMode'
				: def.setting === 'profile'
					? `chargingProfiles.${def.profileId}`
					: def.part;
		try {
			this.onConfirmation?.(command.vin, {
				channel,
				name: command.name,
				target: command.action === 'profile' ? String(command.desired) : JSON.stringify(command.desired),
				sentAt: expected.sentAt,
				expiresAt: expected.expiresAt,
				confirmedAt: status === 'CONFIRMED' ? this.now() : 0,
				status,
			});
		} catch {
			this.log.warn('Command confirmation could not be published.');
		}
	}

	/** Update expired observations locally, without waking the command sender or poll scheduler. */
	private expireConfirmations(): void {
		if (this.stopped) {
			return;
		}
		for (const expected of this.awaitingState.values()) {
			if (!expected.timedOut && this.now() >= expected.expiresAt) {
				expected.timedOut = true;
				this.publishConfirmation(expected, 'TIMED_OUT');
			}
		}
		this.armConfirmationTimer();
	}

	/** Schedule only a local expiry notification; this timer never invokes pump or onCommandSent. */
	private armConfirmationTimer(): void {
		if (this.confirmationTimer !== undefined) {
			this.clearTimer(this.confirmationTimer);
			this.confirmationTimer = undefined;
		}
		if (!this.running || this.stopped) {
			return;
		}
		let due = Infinity;
		for (const expected of this.awaitingState.values()) {
			if (!expected.timedOut) {
				due = Math.min(due, expected.expiresAt);
			}
		}
		if (Number.isFinite(due)) {
			const timer = this.setTimer(
				() => {
					if (this.confirmationTimer !== timer) {
						return;
					}
					this.confirmationTimer = undefined;
					this.expireConfirmations();
				},
				Math.max(0, due - this.now()),
			);
			this.confirmationTimer = timer;
		}
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
				this.log.debug(this.t('%s: Retry skipped in favor of a newer command.', command.name));
				return;
			}
			const now = this.now();
			const waitMs = error.retryAfterMs ?? this.jitteredRetry();
			if (now + waitMs >= entry.expiresAt) {
				this.entries.delete(key);
				this.log.info(
					this.t(
						'%s: Dropped because the wait time of %s min exceeds its lifetime.',
						command.name,
						Math.round(waitMs / 60_000),
					),
				);
				await this.report(command, 'EXPIRED', error.problemType);
				return;
			}
			entry.attempts += 1;
			entry.protectReserve = error.consumesQuota;
			entry.notBefore = now + waitMs;
			this.entries.set(key, entry);
			this.log.warn(
				this.t(
					'%s: %s - attempt %s in %s s.',
					command.name,
					error.message,
					entry.attempts,
					Math.round(waitMs / 1000),
				),
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
			if (this.stopped) {
				return;
			}
			await this.onReport(command.vin, {
				name: command.name,
				result,
				timestamp: this.now(),
				problemType,
				acknowledge,
			});
		} catch {
			if (this.stopped) {
				return;
			}
			// Fehlertexte des State-Backends koennen die volle State-ID und damit die
			// VIN enthalten. Deshalb nur eine eigene, maskierungsfreie Meldung loggen.
			this.log.error(this.t('%s: Result could not be written to ioBroker states.', command.name));
		}
	}

	/**
	 * Der Ist-Zustand einer Domaene aus dem letzten Poll.
	 *
	 * @param command Der Befehl.
	 * @returns Reported boolean or numeric target, or undefined before the first poll.
	 */
	private currentValue(command: ParsedCommand): boolean | number | string | undefined {
		const block = this.blocks.get(command.vin)?.get(command.def.part);
		if (!block) {
			return undefined;
		}
		return this.valueFromBlock(command.def, block);
	}

	/**
	 * Liest den Ist-Zustand aus einem bereits gefundenen Antwortblock.
	 *
	 * @param def Domaene samt Pfad und aktiven Werten.
	 * @param block Der Antwortblock dieser Domaene.
	 * @returns Reported boolean or numeric target, or undefined for incomplete data.
	 */
	private valueFromBlock(
		def: CommandDomainDef,
		block: Record<string, unknown>,
	): boolean | number | string | undefined {
		if (def.setting === 'profile') {
			const profile = findProfile(block, def.profileId!);
			return profile ? canonicalJson(profile) : undefined;
		}
		let current: unknown = block;
		for (const part of def.statePath.split('.')) {
			if (typeof current !== 'object' || current === null) {
				return undefined;
			}
			current = (current as Record<string, unknown>)[part];
		}
		if (def.setting === 'mode') {
			return typeof current === 'string' ? current : undefined;
		}
		if (def.numeric) {
			return typeof current === 'number' ? current : undefined;
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
		return `${command.vin}|${command.def.part}${command.def.numeric ? '|limit' : command.def.setting ? `|${command.def.setting}|${command.def.profileId ?? ''}` : ''}`;
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
