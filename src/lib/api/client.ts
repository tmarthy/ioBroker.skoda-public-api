/**
 * `SkodaApiClient` - die unterste Schicht des Adapters und die einzige Stelle, an der
 * ein Request den Prozess verlaesst.
 *
 * Der Client ist bewusst dumm. Er setzt genau einen Request ab, liest aus **jeder**
 * Antwort die Quota- und Ablauf-Header und gibt sie zusammen mit dem Ergebnis zurueck.
 * Er entscheidet nichts: keine Reserve, keine Warteschlange, keine Wiederholung ueber
 * die Zeit. Das Budget verwaltet der QuotaManager, die Kadenz der PollScheduler;
 * beide brauchen dafuer die Zahlen, die hier hochgereicht
 * werden, und keine vorweggenommene Entscheidung.
 *
 * Jede Meldung, die hier entsteht, ist maskiert (E14): Die VIN steht im URL-Pfad und
 * kommt in `detail` und `instance` jeder Fehlerantwort zurueck.
 */
import {
	consumesQuotaForStatus,
	httpApiError,
	networkApiError,
	parseRetryAfter,
	unexpectedResponseError,
	type ApiError,
} from './errors';
import { createSanitizer, type Sanitizer } from './sanitize';
import type {
	CommandAction,
	CommandDomain,
	StartAirConditioningConfiguration,
	StartAuxiliaryHeatingConfiguration,
	VehicleError,
	VehiclePart,
	VehicleResponse,
} from './types';

/** Die echte API. Vorgabe, solange nichts anderes gesetzt ist. */
export const LIVE_BASE_URL = 'https://public.api.connect.skoda-auto.cz';

/**
 * Umgebungsvariable, mit der die Basis-URL auf den Mock gezogen wird.
 *
 * Bewusst **keine** Einstellung in der Admin-UI (E12): Ein sichtbares Feld
 * "API-Server" laedt dazu ein, den Adapter samt Schluessel auf einen fremden Host
 * zeigen zu lassen. Wer entwickelt, setzt eine Umgebungsvariable; wer den Adapter
 * benutzt, hat damit nichts zu tun.
 */
export const BASE_URL_ENV_VAR = 'SKODA_API_BASE_URL';

/**
 * Zeitgrenze eines einzelnen Requests.
 *
 * Grosszuegig gewaehlt: Die API weckt das Fahrzeug und antwortet dann langsam. Ein zu
 * knapper Wert erzeugt Zeitueberschreitungen fuer Requests, die das Budget trotzdem
 * gekostet haben.
 */
export const DEFAULT_TIMEOUT_MS = 20_000;

/** Der Quota-Stand, wie ihn die `RateLimit-*`-Header melden. */
export interface RateLimitSnapshot {
	/** Requests pro Fenster, laut Doku 20. */
	limit: number;
	/** Verbleibende Requests im laufenden Fenster. */
	remaining: number;
	/** Sekunden bis zum Zuruecksetzen des Fensters. */
	resetInSeconds: number;
}

/** Was jede Antwort ueber Budget und Schluessel verraet. */
export interface ApiMeta {
	/** Fehlt, wenn die Antwort die Header nicht (vollstaendig) mitgeschickt hat. */
	rateLimit?: RateLimitSnapshot;
	/** Ablauf des API-Schluessels aus `X-API-Key-Expires-At`. */
	apiKeyExpiresAt?: Date;
	/**
	 * Ob dieser Request einen aus dem Stundenbudget gekostet hat, nach der
	 * Fehlertabelle. Bei einem Netzwerkfehler konservativ `true` - der Verbrauch ist
	 * dann in Wahrheit unbekannt.
	 */
	consumedQuota: boolean;
}

/** Ergebnis eines Requests: Nutzdaten oder Fehler, in beiden Faellen mit `meta`. */
export type ApiResult<T> = { ok: true; data: T; meta: ApiMeta } | { ok: false; error: ApiError; meta: ApiMeta };

/** Koerper der beiden Befehle, die einen brauchen. */
export type CommandBody = StartAirConditioningConfiguration | StartAuxiliaryHeatingConfiguration;

/** Was der Client zum Arbeiten braucht. */
export interface SkodaApiClientOptions {
	/** Statischer Schluessel aus der MySkoda-App. */
	apiKey: string;
	/** Basis-URL ohne Pfad. Vorgabe: `SKODA_API_BASE_URL`, sonst die echte API. */
	baseUrl?: string;
	/** Zeitgrenze je Request in Millisekunden. */
	timeoutMs?: number;
	/** Weitere Zeichenketten, die in keiner Meldung auftauchen duerfen (z.B. der S-PIN). */
	secrets?: readonly string[];
}

/** Was `send()` an die oeffentlichen Methoden zurueckgibt. */
interface HttpPayload {
	/** HTTP-Status der Antwort. */
	status: number;
	/** Roher Antwortkoerper. */
	body: string;
}

/**
 * Liest eine ganze Zahl aus einem Header.
 *
 * `parseInt` statt `Number`, weil der Entwurf von RFC 9239 auch Formen wie
 * `20, 20;w=3600` zulaesst - dann zaehlt die fuehrende Zahl.
 *
 * @param value Inhalt des Headers, oder null.
 * @returns Die Zahl, oder undefined wenn der Header fehlt oder keine Zahl enthaelt.
 */
function readInteger(value: string | null): number | undefined {
	if (value === null) {
		return undefined;
	}
	const parsed = Number.parseInt(value, 10);
	return Number.isFinite(parsed) ? parsed : undefined;
}

/**
 * Liest den Quota-Stand aus den Antwortheadern.
 *
 * Alles oder nichts: Ein halber Stand waere schlimmer als keiner, weil der
 * QuotaManager ihn fuer bare Muenze naehme.
 *
 * @param headers Header der Antwort.
 * @returns Der Quota-Stand, oder undefined.
 */
function readRateLimit(headers: Headers): RateLimitSnapshot | undefined {
	const limit = readInteger(headers.get('RateLimit-Limit'));
	const remaining = readInteger(headers.get('RateLimit-Remaining'));
	const resetInSeconds = readInteger(headers.get('RateLimit-Reset'));
	if (limit === undefined || remaining === undefined || resetInSeconds === undefined) {
		return undefined;
	}
	return { limit, remaining, resetInSeconds };
}

/**
 * Liest das Ablaufdatum des Schluessels.
 *
 * Ueber `Date.parse` und damit nach Millisekunden - an den Zeitstempeln dieser API
 * haengen 0 bis 9 Nachkommastellen, ein Vergleich als Zeichenkette waere unzuverlaessig.
 *
 * @param headers Header der Antwort.
 * @returns Der Ablaufzeitpunkt, oder undefined.
 */
function readApiKeyExpiry(headers: Headers): Date | undefined {
	const value = headers.get('X-API-Key-Expires-At');
	if (!value) {
		return undefined;
	}
	const at = Date.parse(value);
	return Number.isNaN(at) ? undefined : new Date(at);
}

/**
 * Bringt die Basis-URL auf die Form `schema://host[:port][/prefix]`.
 *
 * @param value Rohwert aus Option oder Umgebungsvariable.
 * @returns Die URL ohne abschliessenden Schraegstrich.
 * @throws {TypeError} Wenn der Wert keine gueltige URL ist - das soll beim Start
 * auffallen und nicht erst beim ersten Request.
 */
function normalizeBaseUrl(value: string): string {
	const parsed = new URL(value.trim());
	return `${parsed.origin}${parsed.pathname.replace(/\/+$/, '')}`;
}

/**
 * Wertet den Antwortkoerper eines erfolgreichen `GET` aus.
 *
 * `vehicle` ist das einzige Pflichtfeld der Antwort. `errors` wird hier ausdruecklich
 * **nicht** auf ein leeres Array normalisiert: Die echte API laesst das Feld bei einer
 * fehlerfreien Antwort ganz weg, und der optionale Typ ist genau der Waechter, der
 * `body.errors.map(...)` im weiteren Adapter verhindert (siehe `vehicleErrors()`).
 *
 * @param body Roher Antwortkoerper.
 * @returns Die Antwort, oder undefined wenn sie keine Fahrzeugdaten enthaelt.
 */
function parseVehicleResponse(body: string): VehicleResponse | undefined {
	let parsed: unknown;
	try {
		parsed = JSON.parse(body);
	} catch {
		return undefined;
	}
	if (typeof parsed !== 'object' || parsed === null) {
		return undefined;
	}
	const candidate = parsed as Partial<VehicleResponse>;
	if (typeof candidate.vehicle !== 'object' || candidate.vehicle === null) {
		return undefined;
	}
	return candidate as VehicleResponse;
}

/**
 * Die Teilfehler einer Antwort - **immer** ueber diese Funktion.
 *
 * Die echte API laesst `errors` bei einer fehlerfreien Antwort ganz weg, entgegen dem
 * Beispiel in Skodas Dokumentation (an vier echten Aufnahmen gemessen). Ein direktes
 * `response.errors.map(...)` besteht darum jeden Test und faellt erst im Betrieb um.
 *
 * @param response Eine erfolgreich gelesene Fahrzeugantwort.
 * @returns Die gemeldeten Teilfehler, im Normalfall eine leere Liste.
 */
export function vehicleErrors(response: VehicleResponse): VehicleError[] {
	return response.errors ?? [];
}

/**
 * Setzt Requests gegen die MySkoda Public API ab und reicht Ergebnis, Quota-Stand und
 * Schluesselablauf unveraendert nach oben.
 */
export class SkodaApiClient {
	private readonly apiKey: string;
	private readonly timeoutMs: number;
	private readonly sanitizer: Sanitizer;

	/** Basis-URL ohne abschliessenden Schraegstrich, z.B. `http://127.0.0.1:8099`. */
	public readonly baseUrl: string;

	/**
	 * @param options Schluessel, Basis-URL, Zeitgrenze und weitere Geheimnisse.
	 */
	public constructor(options: SkodaApiClientOptions) {
		this.apiKey = options.apiKey;
		this.baseUrl = normalizeBaseUrl(options.baseUrl ?? process.env[BASE_URL_ENV_VAR] ?? LIVE_BASE_URL);
		this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
		this.sanitizer = createSanitizer({ apiKey: options.apiKey, secrets: options.secrets });
	}

	/**
	 * Holt den Zustand eines Fahrzeugs.
	 *
	 * Ohne `include` liefert die API genau die Teile, die das Fahrzeug unterstuetzt -
	 * das ist die eingebaute Faehigkeitserkennung (E13). `include` spart keine Quota.
	 *
	 * @param vin Fahrgestellnummer.
	 * @param include Teile, auf die die Antwort beschraenkt werden soll.
	 * @returns Die Fahrzeugantwort oder ein Fehler, in beiden Faellen mit `meta`.
	 */
	public async getVehicle(vin: string, include?: readonly VehiclePart[]): Promise<ApiResult<VehicleResponse>> {
		const url = this.vehicleUrl(vin);
		if (include && include.length > 0) {
			url.searchParams.set('include', include.join(','));
		}

		const raw = await this.send(url, 'GET');
		if (!raw.ok) {
			return raw;
		}

		const parsed = parseVehicleResponse(raw.data.body);
		if (!parsed) {
			return {
				ok: false,
				error: unexpectedResponseError(
					raw.data.status,
					'Response without vehicle data - no JSON object with "vehicle"',
					this.sanitizer,
				),
				meta: raw.meta,
			};
		}
		return { ok: true, data: parsed, meta: raw.meta };
	}

	/**
	 * Setzt einen Befehl ab.
	 *
	 * Die API antwortet mit `202 Accepted` und einem leeren Koerper. Ob das Fahrzeug
	 * den Befehl ausgefuehrt hat, sagt sie nicht - es gibt keinen Endpunkt dafuer.
	 * `ok: true` heisst darum nur: an die API uebergeben (E6).
	 *
	 * @param vin Fahrgestellnummer.
	 * @param domain Die Domaene, z.B. `charging`.
	 * @param action `start` oder `stop`.
	 * @param body Koerper fuer die Befehle, die einen brauchen (Klima, Standheizung).
	 * @returns Leeres Ergebnis oder ein Fehler, in beiden Faellen mit `meta`.
	 */
	public async sendCommand(
		vin: string,
		domain: CommandDomain,
		action: CommandAction,
		body?: CommandBody,
	): Promise<ApiResult<void>> {
		const raw = await this.send(this.vehicleUrl(vin, `/${domain}/${action}`), 'POST', body);
		if (!raw.ok) {
			return raw;
		}
		return { ok: true, data: undefined, meta: raw.meta };
	}

	/**
	 * Baut die URL zu einem Fahrzeug.
	 *
	 * @param vin Fahrgestellnummer.
	 * @param suffix Pfad hinter der VIN, z.B. `/charging/start`.
	 * @returns Die vollstaendige URL.
	 */
	private vehicleUrl(vin: string, suffix = ''): URL {
		// encodeURIComponent: Eine vertippte VIN aus der Instanzkonfiguration darf den
		// Pfad nicht verlassen koennen.
		return new URL(`${this.baseUrl}/api/v1/vehicles/${encodeURIComponent(vin)}${suffix}`);
	}

	/**
	 * Setzt genau einen Request ab und wertet Status und Header aus.
	 *
	 * @param url Ziel-URL.
	 * @param method HTTP-Methode.
	 * @param body Koerper, wird als JSON gesendet.
	 * @returns Rohantwort bei 2xx, sonst der Fehler nach der Fehlertabelle.
	 */
	private async send(url: URL, method: 'GET' | 'POST', body?: CommandBody): Promise<ApiResult<HttpPayload>> {
		const headers: Record<string, string> = {
			'X-API-Key': this.apiKey,
			Accept: 'application/json, application/problem+json',
		};
		if (body !== undefined) {
			headers['Content-Type'] = 'application/json';
		}

		let response: Response;
		try {
			response = await fetch(url, {
				method,
				headers,
				body: body === undefined ? undefined : JSON.stringify(body),
				signal: AbortSignal.timeout(this.timeoutMs),
			});
		} catch (cause: unknown) {
			// Ohne Antwort gibt es keine Header und damit keinen Quota-Stand. Ob der
			// Request gezaehlt wurde, weiss nur der Server.
			return { ok: false, error: networkApiError(cause, this.sanitizer), meta: { consumedQuota: true } };
		}

		const rateLimit = readRateLimit(response.headers);
		const apiKeyExpiresAt = readApiKeyExpiry(response.headers);

		let payload: string;
		try {
			payload = await response.text();
		} catch (cause: unknown) {
			// Header gelesen, Koerper unterwegs abgerissen: Der Request hat gezaehlt.
			return {
				ok: false,
				error: networkApiError(cause, this.sanitizer),
				meta: { rateLimit, apiKeyExpiresAt, consumedQuota: consumesQuotaForStatus(response.status) },
			};
		}

		if (!response.ok) {
			const error = httpApiError({
				status: response.status,
				body: payload,
				retryAfterMs: parseRetryAfter(response.headers.get('Retry-After')),
				sanitizer: this.sanitizer,
			});
			return { ok: false, error, meta: { rateLimit, apiKeyExpiresAt, consumedQuota: error.consumesQuota } };
		}

		return {
			ok: true,
			data: { status: response.status, body: payload },
			meta: { rateLimit, apiKeyExpiresAt, consumedQuota: consumesQuotaForStatus(response.status) },
		};
	}
}
