/**
 * `application/problem+json` (RFC 9457) in eine diskriminierte Union.
 *
 * Die Zuordnung folgt der verbindlichen Fehlertabelle aus
 * `docs/implementation-plan.md`, Abschnitt 5. Sie steht hier als Datenstruktur und
 * nicht als `if`-Kette, damit ein Test sie Zeile fuer Zeile nachpruefen kann.
 *
 * Zwei Eigenheiten der API bestimmen den Aufbau:
 *
 * 1. **Die beiden `429`-Ursachen unterscheiden sich nur am `type`.** Weder der Status
 *    noch die `RateLimit-*`-Header verraten, ob das Stundenbudget erschoepft ist oder
 *    ob das Fahrzeug selbst gerade nichts annimmt - laut Spec kann ausgerechnet der
 *    Request, der das Budget aufbraucht, derjenige sein, den das Auto ablehnt.
 * 2. **Nicht jede Antwort kostet Quota.** Was kostet und was nicht, steht in der
 *    Tabelle; diese Datei entscheidet daraus nichts, sie meldet es nur. Was daraus
 *    folgt, ist Sache des QuotaManagers und des PollSchedulers.
 */
import { createSanitizer, type Sanitizer } from './sanitize';
import type { ProblemDetail } from './types';

/** Fehlerarten, in die eine Antwort der API zerfaellt. */
export type ApiErrorKind =
	| 'api-key-expired'
	| 'api-key-not-authorized'
	| 'operation-not-authorized'
	| 'operation-not-supported'
	| 'operation-disabled'
	| 'rate-limit-exceeded'
	| 'vehicle-not-accepting-requests'
	| 'bad-request'
	| 'not-found'
	| 'server-error'
	| 'network-error'
	| 'unexpected';

/**
 * Die sieben Problemtypen, die Skoda benennt. Alles andere kommt als `about:blank`
 * und ist nur am Status zu erkennen.
 */
export const PROBLEM_SLUGS = [
	'api-key-expired',
	'api-key-not-authorized',
	'operation-not-authorized',
	'operation-not-supported',
	'operation-disabled',
	'rate-limit-exceeded',
	'vehicle-not-accepting-requests',
] as const satisfies readonly ApiErrorKind[];

export type ProblemSlug = (typeof PROBLEM_SLUGS)[number];

/** Was die Fehlertabelle zu einer Fehlerart sagt. */
interface ErrorTraits {
	/** Verbraucht die Antwort einen Request aus dem Stundenbudget? */
	consumesQuota: boolean;
	/** Darf derselbe Request wiederholt werden? */
	retryable: boolean;
	/** Wie oft hoechstens. `Infinity` heisst: nicht durch eine Zahl begrenzt. */
	maxRetries: number;
}

/**
 * Die Fehlertabelle aus `docs/implementation-plan.md`, Abschnitt 5.
 *
 * `rate-limit-exceeded` ist der einzige Fall ohne Obergrenze: Wer auf das Zuruecksetzen
 * des Fensters wartet, wiederholt nicht "zu oft", er wartet. Begrenzt wird der Befehl
 * dort durch seine TTL, nicht durch einen Zaehler (E15).
 *
 * `network-error` traegt `consumesQuota: true`, obwohl der Verbrauch in Wahrheit
 * **unbekannt** ist: Die Antwort kann uns unterwegs verloren gegangen sein, nachdem der
 * Server sie schon gebucht hat. Die Tabelle schreibt vor, das konservativ als verbraucht
 * zu zaehlen - lieber ein Request zu wenig als ein unerwartetes `429`.
 */
const TRAITS: Readonly<Record<ApiErrorKind, ErrorTraits>> = {
	'api-key-expired': { consumesQuota: false, retryable: false, maxRetries: 0 },
	'api-key-not-authorized': { consumesQuota: false, retryable: false, maxRetries: 0 },
	'operation-not-authorized': { consumesQuota: true, retryable: false, maxRetries: 0 },
	'operation-not-supported': { consumesQuota: true, retryable: false, maxRetries: 0 },
	'operation-disabled': { consumesQuota: true, retryable: false, maxRetries: 0 },
	'rate-limit-exceeded': { consumesQuota: false, retryable: true, maxRetries: Number.POSITIVE_INFINITY },
	'vehicle-not-accepting-requests': { consumesQuota: false, retryable: true, maxRetries: 3 },
	'bad-request': { consumesQuota: true, retryable: false, maxRetries: 0 },
	'not-found': { consumesQuota: true, retryable: false, maxRetries: 0 },
	'server-error': { consumesQuota: true, retryable: true, maxRetries: 1 },
	'network-error': { consumesQuota: true, retryable: true, maxRetries: 1 },
	// Eine Antwort, die in keine Zeile der Tabelle passt. Nicht wiederholen: Was wir
	// nicht verstehen, wiederholen wir auch nicht auf gut Glueck.
	unexpected: { consumesQuota: true, retryable: false, maxRetries: 0 },
};

/**
 * Status, die laut Skodas Dokumentation grundsaetzlich nichts kosten.
 *
 * Gilt nur fuer den Auffangfall `unexpected`. Die Fehlertabelle ist feiner und weicht
 * an einer Stelle bewusst ab: `403 operation-not-authorized` verbraucht Quota, obwohl
 * `403` hier steht.
 */
const FREE_STATUS = new Set([401, 403, 429]);

/** Gemeinsame Angaben jedes Fehlers. */
interface ApiErrorBase {
	/** Fertig aufbereitete, **bereits maskierte** Meldung fuer das Log. */
	message: string;
	/** Verbraucht die Antwort einen Request aus dem Stundenbudget? */
	consumesQuota: boolean;
	/** Darf derselbe Request wiederholt werden? */
	retryable: boolean;
	/** Obergrenze der Wiederholungen laut Fehlertabelle; `Infinity` heisst unbegrenzt. */
	maxRetries: number;
	/** Wartezeit aus `Retry-After`, in Millisekunden. Nur gesetzt, wenn der Header kam. */
	retryAfterMs?: number;
	/** Der rohe `type` aus `problem+json`, maskiert. */
	problemType?: string;
	/** `title` aus `problem+json`, maskiert. */
	title?: string;
	/** `detail` aus `problem+json`, maskiert. Enthaelt haeufig den URL-Pfad. */
	detail?: string;
}

/** Eine Antwort der API, die nicht der Erfolgsfall ist. */
export interface HttpApiError extends ApiErrorBase {
	/** Die Zeile der Fehlertabelle, in die diese Antwort faellt. */
	kind: Exclude<ApiErrorKind, 'network-error'>;
	/** HTTP-Status der Antwort. */
	status: number;
}

/** Es kam gar keine Antwort zustande: Verbindung, DNS oder Zeitueberschreitung. */
export interface NetworkApiError extends ApiErrorBase {
	/** Immer `network-error` - das Unterscheidungsmerkmal der Union. */
	kind: 'network-error';
	/** Immer undefined: Es gab keine Antwort und damit keinen Status. */
	status: undefined;
	/** True, wenn `AbortSignal.timeout()` zugeschlagen hat. */
	timeout: boolean;
}

export type ApiError = HttpApiError | NetworkApiError;

/**
 * Sagt, ob ein Status Quota verbraucht - fuer den Erfolgsfall und fuer Antworten,
 * die in keine Zeile der Tabelle passen.
 *
 * @param status HTTP-Status der Antwort.
 * @returns True, wenn die Antwort einen Request aus dem Stundenbudget kostet.
 */
export function consumesQuotaForStatus(status: number): boolean {
	return !FREE_STATUS.has(status);
}

/**
 * Zerlegt einen Antwortkoerper nach `problem+json`.
 *
 * Bewusst nachsichtig und Feld fuer Feld geprueft: Zwischen Adapter und API sitzen
 * Proxys, die im Stoerungsfall HTML liefern, und ein unbrauchbarer Koerper darf nicht
 * dazu fuehren, dass der Status verloren geht. Uebernommen wird nur, was die Spec
 * kennt und was tatsaechlich den erwarteten Typ hat.
 *
 * @param body Roher Antwortkoerper.
 * @returns Die erkannten Felder, oder undefined wenn es kein JSON-Objekt war.
 */
export function parseProblemDetail(body: string): ProblemDetail | undefined {
	if (!body) {
		return undefined;
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(body);
	} catch {
		return undefined;
	}
	if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
		return undefined;
	}
	const raw = parsed as Record<string, unknown>;
	const problem: ProblemDetail = {};
	for (const field of ['type', 'title', 'detail', 'instance'] as const) {
		const value = raw[field];
		if (typeof value === 'string' && value.length > 0) {
			problem[field] = value;
		}
	}
	if (typeof raw.status === 'number') {
		problem.status = raw.status;
	}
	// Ein JSON-Objekt ohne ein einziges bekanntes Feld ist kein Problem-Objekt. Dann
	// lieber undefined melden, damit der Rohtext in der Meldung landet.
	return Object.keys(problem).length > 0 ? problem : undefined;
}

/**
 * Holt den Problemtyp aus einer Typ-URI.
 *
 * Verglichen wird nur das letzte Pfadsegment: Der Hostname davor ist Skodas Sache und
 * darf sich aendern, ohne dass die Fehlerbehandlung ausfaellt.
 *
 * @param type Inhalt des Feldes `type`, z.B. `.../problems/rate-limit-exceeded`.
 * @returns Der bekannte Problemtyp, oder undefined.
 */
export function problemSlug(type: string | undefined): ProblemSlug | undefined {
	if (!type) {
		return undefined;
	}
	const slug = type.slice(type.lastIndexOf('/') + 1);
	return (PROBLEM_SLUGS as readonly string[]).includes(slug) ? (slug as ProblemSlug) : undefined;
}

/**
 * Ordnet Status und Problemtyp einer Zeile der Fehlertabelle zu.
 *
 * Der Problemtyp hat Vorrang vor dem Status - er ist das einzige Merkmal, an dem sich
 * die beiden `429` und die beiden `403` unterscheiden lassen.
 *
 * @param status HTTP-Status der Antwort.
 * @param type Inhalt des Feldes `type` aus `problem+json`.
 * @returns Die Fehlerart.
 */
export function classify(status: number, type?: string): Exclude<ApiErrorKind, 'network-error'> {
	const slug = problemSlug(type);
	if (slug) {
		return slug;
	}
	if (status === 400) {
		return 'bad-request';
	}
	if (status === 404) {
		return 'not-found';
	}
	if (status >= 500) {
		return 'server-error';
	}
	return 'unexpected';
}

/**
 * Wertet den Header `Retry-After` aus - als Sekunden oder als HTTP-Datum.
 *
 * Das Datum wird nach Millisekunden geparst und nicht als Zeichenkette verglichen;
 * an den Zeitstempeln dieser API haengen 0 bis 9 Nachkommastellen.
 *
 * @param value Inhalt des Headers, oder null.
 * @param now Jetzt-Zeitpunkt in Millisekunden, ersetzbar fuer Tests.
 * @returns Wartezeit in Millisekunden, oder undefined wenn der Header fehlt oder unbrauchbar ist.
 */
export function parseRetryAfter(value: string | null | undefined, now: number = Date.now()): number | undefined {
	if (value === null || value === undefined) {
		return undefined;
	}
	const text = value.trim();
	if (!text) {
		return undefined;
	}
	if (/^\d+$/.test(text)) {
		return Number(text) * 1000;
	}
	const at = Date.parse(text);
	return Number.isNaN(at) ? undefined : Math.max(0, at - now);
}

/**
 * Maskiert einen Wert, sofern er ueberhaupt da ist.
 *
 * @param value Der rohe Wert aus dem Problem-Objekt.
 * @param sanitizer Maskierung, die auf den Wert angewandt wird.
 * @returns Der maskierte Wert, oder undefined.
 */
function sanitized(value: string | undefined, sanitizer: Sanitizer): string | undefined {
	return value === undefined ? undefined : sanitizer(value);
}

/** Woraus ein Fehler zu einer HTTP-Antwort entsteht. */
export interface HttpErrorInput {
	/** HTTP-Status der Antwort. */
	status: number;
	/** Roher Antwortkoerper. */
	body?: string;
	/** Bereits ausgewerteter `Retry-After`-Header, in Millisekunden. */
	retryAfterMs?: number;
	/** Maskierung; ohne Angabe wird nur die VIN maskiert. */
	sanitizer?: Sanitizer;
}

/**
 * Baut den Fehler zu einer HTTP-Antwort.
 *
 * Alle uebernommenen Felder sind maskiert - `detail` und `instance` enthalten
 * regelmaessig den URL-Pfad und damit die VIN.
 *
 * @param input Status, Koerper, Wartezeit und Maskierung.
 * @returns Der Fehler samt Quota- und Wiederholungsangaben aus der Fehlertabelle.
 */
export function httpApiError(input: HttpErrorInput): HttpApiError {
	const sanitizer = input.sanitizer ?? createSanitizer();
	const problem = parseProblemDetail(input.body ?? '');
	const kind = classify(input.status, problem?.type);
	const traits = TRAITS[kind];

	const problemType = sanitized(problem?.type, sanitizer);
	const title = sanitized(problem?.title, sanitizer);
	const detail = sanitized(problem?.detail, sanitizer);
	const instance = sanitized(problem?.instance, sanitizer);

	const parts = [`HTTP ${input.status} (${kind})`];
	if (title) {
		parts.push(title);
	}
	if (detail) {
		parts.push(detail);
	}
	if (instance) {
		parts.push(`at ${instance}`);
	}
	// Kein JSON-Objekt im Koerper: den Anfang des Textes mitgeben, sonst steht im Log
	// nur eine nackte Zahl. Auch dieser Text wird maskiert.
	if (!problem && input.body) {
		parts.push(sanitizer(input.body.slice(0, 200)));
	}

	return {
		kind,
		status: input.status,
		message: parts.join(' - '),
		consumesQuota: kind === 'unexpected' ? consumesQuotaForStatus(input.status) : traits.consumesQuota,
		retryable: traits.retryable,
		maxRetries: traits.maxRetries,
		retryAfterMs: input.retryAfterMs,
		problemType,
		title,
		detail,
	};
}

/**
 * Baut den Fehler fuer eine Anfrage, die gar keine Antwort bekommen hat.
 *
 * @param cause Der von `fetch` geworfene Fehler.
 * @param sanitizer Maskierung; ohne Angabe wird nur die VIN maskiert.
 * @returns Der Netzwerkfehler, konservativ als quotaverbrauchend gezaehlt.
 */
export function networkApiError(cause: unknown, sanitizer: Sanitizer = createSanitizer()): NetworkApiError {
	// `AbortSignal.timeout()` bricht mit einer DOMException namens TimeoutError ab.
	const timeout = cause instanceof Error && (cause.name === 'TimeoutError' || cause.name === 'AbortError');
	const traits = TRAITS['network-error'];
	return {
		kind: 'network-error',
		status: undefined,
		timeout,
		message: `${timeout ? 'Timeout' : 'Network error'} - ${sanitizer(cause)}`,
		consumesQuota: traits.consumesQuota,
		retryable: traits.retryable,
		maxRetries: traits.maxRetries,
	};
}

/**
 * Baut den Fehler fuer eine Antwort, die zwar ankam, aber nicht auswertbar war -
 * etwa ein `200` ohne Fahrzeugdaten.
 *
 * @param status HTTP-Status der Antwort.
 * @param reason Was daran nicht stimmte.
 * @param sanitizer Maskierung; ohne Angabe wird nur die VIN maskiert.
 * @returns Ein Fehler der Art `unexpected`.
 */
export function unexpectedResponseError(
	status: number,
	reason: string,
	sanitizer: Sanitizer = createSanitizer(),
): HttpApiError {
	const traits = TRAITS.unexpected;
	return {
		kind: 'unexpected',
		status,
		message: `HTTP ${status} (unexpected) - ${sanitizer(reason)}`,
		consumesQuota: consumesQuotaForStatus(status),
		retryable: traits.retryable,
		maxRetries: traits.maxRetries,
	};
}
