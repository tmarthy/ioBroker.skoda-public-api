/**
 * Der Verbindungstest der Admin-UI.
 *
 * Er setzt genau einen `GET` ab und uebersetzt das Ergebnis in einen Satz, aus dem
 * hervorgeht, was zu tun ist. Ohne ihn aeussert sich ein Tippfehler in der VIN als
 * `403 api-key-not-authorized` - eine Meldung, aus der niemand die Ursache erraet, weil
 * derselbe Fehler auch bei einem Schluessel kommt, der fuer ein anderes Fahrzeug
 * erzeugt wurde.
 *
 * Angefordert wird nur `include=info`: Das kostet dieselbe Quota wie alles andere (E13),
 * liefert aber Name und Kennzeichen zur Wiedererkennung - und eben **nicht** die
 * Parkposition, die in einem Verbindungstest nichts zu suchen hat (E14).
 */
import type { ApiMeta, ApiResult } from './api/client';
import type { ApiError } from './api/errors';
import type { VehiclePart, VehicleResponse } from './api/types';
import type { VehicleQuota } from './quota/VehicleQuotaManager';
import { translateFallback, type Translate } from './i18n';

/** Nur Antworten fuer den aktiven Schluessel duerfen dessen Betriebszustand aendern. */
export interface ConnectionTestTracking {
	/** Schluessel aus dem noch ungespeicherten Formular. */
	testedKey: string;
	/** Schluessel, mit dem die laufende Instanz arbeitet. */
	activeKey: string;
	/** Budget ausschliesslich dieses aktiven Schluessels. */
	quota?: Pick<VehicleQuota, 'trackRequest' | 'recordResponse'>;
	/** Beobachter fuer das Ablaufdatum des aktiven Schluessels. */
	onResponse?: (meta: ApiMeta) => Promise<void> | void;
}

/** Der Ausschnitt des Clients, den der Test braucht. */
export interface ConnectionTestClient {
	/** Holt den Zustand eines Fahrzeugs. */
	getVehicle(vin: string, include?: readonly VehiclePart[]): Promise<ApiResult<VehicleResponse>>;
}

/** Was die Admin-UI anzeigt. */
export interface ConnectionTestResult {
	/** Ob der Test durchging. */
	ok: boolean;
	/** Fertiger Text; er stammt aus der HTTP-Schicht und ist damit maskiert. */
	text: string;
	/** Die Begleitangaben der Antwort, damit der Aufrufer den Quota-Stand buchen kann. */
	meta?: ApiMeta;
}

/** Eine VIN nach ISO 3779: 17 Zeichen, ohne I, O und Q. */
const VIN_PATTERN = /^[A-HJ-NPR-Z0-9]{17}$/;

/**
 * Prueft Schluessel und VIN mit genau einem Request.
 *
 * @param client Die HTTP-Schicht, bereits mit dem zu pruefenden Schluessel gebaut.
 * @param vin Die zu pruefende Fahrgestellnummer.
 * @param now Jetzt-Zeitpunkt in Millisekunden, ersetzbar fuer Tests.
 * @param tracking Optionaler Betriebszustand der laufenden Instanz.
 * @param t Uebersetzer fuer das Ergebnis.
 * @returns Ergebnis samt Text fuer die Admin-UI.
 */
export async function testConnection(
	client: ConnectionTestClient,
	vin: string,
	now: number = Date.now(),
	tracking?: ConnectionTestTracking,
	t: Translate = translateFallback,
): Promise<ConnectionTestResult> {
	const active = tracking?.testedKey === tracking?.activeKey ? tracking : undefined;
	const permit = active?.quota?.trackRequest(vin);
	const result = await client.getVehicle(vin, ['info']);
	active?.quota?.recordResponse(vin, result.meta, permit);
	await active?.onResponse?.(result.meta);
	if (!result.ok) {
		return { ok: false, text: explainError(result.error, result.meta, now, t), meta: result.meta };
	}

	const vehicle = result.data.vehicle as unknown as Record<string, unknown>;
	// Name oder Kennzeichen, damit der Nutzer sein Fahrzeug wiedererkennt. Die VIN
	// steht bewusst nicht im Text: Sie ist das eine Datum, das nirgends auftauchen
	// soll (E14), und wer sie gerade eingetippt hat, kennt sie ohnehin.
	const label = [vehicle.name, vehicle.licensePlate].find(
		(value): value is string => typeof value === 'string' && value.length > 0,
	);

	const parts = [t('Connection established%s.', label ? ` - ${label}` : '')];
	const expiry = describeKeyExpiry(result.meta, now, t);
	if (expiry) {
		parts.push(expiry);
	}
	const quota = describeQuota(result.meta, t);
	if (quota) {
		parts.push(quota);
	}
	return { ok: true, text: parts.join(' '), meta: result.meta };
}

/**
 * Prueft, ob eine Zeichenkette als Fahrgestellnummer taugt.
 *
 * Das kostet keinen Request und faengt den haeufigsten Fehler ab, bevor er einen
 * kostet.
 *
 * @param vin Die zu pruefende Zeichenkette.
 * @returns Die gross geschriebene VIN, oder undefined.
 */
export function normalizeVin(vin: unknown): string | undefined {
	const value = typeof vin === 'string' ? vin.trim().toUpperCase() : '';
	return VIN_PATTERN.test(value) ? value : undefined;
}

/** Wogegen der Test laufen soll. */
export interface ConnectionTestTarget {
	/** Der zu pruefende Schluessel. */
	apiKey: string;
	/** Die zu pruefende Fahrgestellnummer. */
	vin: string;
}

/**
 * Sucht Schluessel und VIN fuer den Test zusammen.
 *
 * Vorrang haben die Werte aus dem Formular: Wer gerade einen neuen Schluessel
 * eingetippt hat, will genau den pruefen und nicht den zuletzt gespeicherten.
 * Geprueft wird das **erste** Fahrzeug - jedes weitere kostete einen weiteren
 * Request. Ist dessen VIN unbrauchbar, wird das gemeldet, statt still das zweite zu
 * nehmen: Sonst meldet der Test Erfolg fuer ein Fahrzeug, das niemand gemeint hat.
 *
 * @param payload Die Werte aus dem Formular.
 * @param fallback Die gespeicherte Instanzkonfiguration.
 * @param fallback.apiKey Der gespeicherte Schluessel.
 * @param fallback.vins Die gespeicherte Fahrzeugliste.
 * @param t Uebersetzer fuer Beanstandungen.
 * @returns Das Ziel, oder die Beanstandung fuer die Admin-UI.
 */
export function pickTestTarget(
	payload: unknown,
	fallback: { apiKey?: string; vins?: unknown },
	t: Translate = translateFallback,
): ConnectionTestTarget | { problem: string } {
	const data = (payload ?? {}) as Record<string, unknown>;
	const apiKey = (typeof data.apiKey === 'string' ? data.apiKey.trim() : '') || (fallback.apiKey ?? '').trim();
	if (!apiKey) {
		return {
			problem: t('No API key entered. Create one in the MyŠkoda app under "API key".'),
		};
	}

	const rows = Array.isArray(data.vins) && data.vins.length > 0 ? data.vins : fallback.vins;
	const first = Array.isArray(rows) ? rows[0] : undefined;
	if (first === undefined) {
		return { problem: t('No vehicle entered.') };
	}

	const vin = normalizeVin(typeof first === 'string' ? first : (first as { vin?: unknown }).vin);
	if (!vin) {
		return {
			problem: t(
				'The first row of the vehicle list is not a valid VIN: 17 digits and uppercase letters excluding I, O and Q.',
			),
		};
	}
	return { apiKey, vin };
}

/**
 * Uebersetzt einen Fehler in einen Satz, aus dem hervorgeht, was zu tun ist.
 *
 * @param error Der Fehler aus dem Client.
 * @param meta Die Begleitangaben der Antwort.
 * @param now Jetzt-Zeitpunkt in Millisekunden.
 * @param t Uebersetzer fuer das Ergebnis.
 * @returns Der Text fuer die Admin-UI.
 */
function explainError(error: ApiError, meta: ApiMeta, now: number, t: Translate): string {
	switch (error.kind) {
		case 'api-key-expired':
			return t('The API key has expired. Create a new one in the MyŠkoda app under "API key".');
		case 'api-key-not-authorized':
			return t(
				'The key is not valid for this VIN. Common causes are a mistyped VIN or a vehicle which was not selected when the key was created.',
			);
		case 'not-found':
			return t('No vehicle exists for this VIN. Please check all 17 characters.');
		case 'rate-limit-exceeded': {
			const duration = formatMinutes(error.retryAfterMs ?? metaResetMs(meta), t);
			return t(
				'The hourly quota is exhausted%s. The key itself is valid.',
				duration ? t(', try again in %s', duration) : '',
			);
		}
		case 'vehicle-not-accepting-requests':
			return t('The vehicle is currently not accepting requests. The key and VIN are valid; try again later.');
		case 'network-error':
			return t('The API could not be reached: %s', error.message);
		case 'server-error':
			return t('The API reports a service disruption: %s', error.message);
		default:
			return t('The test failed: %s%s', error.message, describeExpiryHint(meta, now, t));
	}
}

/**
 * Ergaenzt einen Hinweis auf den Schluesselablauf, falls die Antwort ihn mitbrachte.
 *
 * @param meta Die Begleitangaben der Antwort.
 * @param now Jetzt-Zeitpunkt in Millisekunden.
 * @param t Uebersetzer fuer das Ergebnis.
 * @returns Der Zusatz, oder eine leere Zeichenkette.
 */
function describeExpiryHint(meta: ApiMeta, now: number, t: Translate): string {
	const expiry = describeKeyExpiry(meta, now, t);
	return expiry ? ` ${expiry}` : '';
}

/**
 * Beschreibt den Ablauf des Schluessels.
 *
 * @param meta Die Begleitangaben der Antwort.
 * @param now Jetzt-Zeitpunkt in Millisekunden.
 * @param t Uebersetzer fuer das Ergebnis.
 * @returns Der Satz, oder undefined wenn die Antwort nichts dazu sagte.
 */
function describeKeyExpiry(meta: ApiMeta, now: number, t: Translate): string | undefined {
	if (!meta.apiKeyExpiresAt) {
		return undefined;
	}
	const days = Math.floor((meta.apiKeyExpiresAt.getTime() - now) / 86_400_000);
	const date = meta.apiKeyExpiresAt.toISOString().slice(0, 10);
	if (days < 0) {
		return t('The key has been expired since %s.', date);
	}
	return t('The key is valid for another %s day%s (until %s).', days, days === 1 ? '' : t('s'), date);
}

/**
 * Beschreibt den Stand des Stundenbudgets.
 *
 * @param meta Die Begleitangaben der Antwort.
 * @param t Uebersetzer fuer das Ergebnis.
 * @returns Der Satz, oder undefined wenn die Header fehlten.
 */
function describeQuota(meta: ApiMeta, t: Translate): string | undefined {
	if (!meta.rateLimit) {
		return undefined;
	}
	const duration = formatMinutes(meta.rateLimit.resetInSeconds * 1000, t);
	return t(
		'Quota: %s of %s requests available; window resets in %s.',
		meta.rateLimit.remaining,
		meta.rateLimit.limit,
		duration,
	);
}

/**
 * Die Wartezeit aus `meta`, falls der Fehler selbst keine mitbrachte.
 *
 * @param meta Die Begleitangaben der Antwort.
 * @returns Millisekunden, oder undefined.
 */
function metaResetMs(meta: ApiMeta): number | undefined {
	return meta.rateLimit ? meta.rateLimit.resetInSeconds * 1000 : undefined;
}

/**
 * Formt Millisekunden zu einer lesbaren Wartezeit.
 *
 * @param ms Die Wartezeit.
 * @param t Uebersetzer fuer die Zeitangabe.
 * @returns Etwas wie `42 Minuten`, oder eine leere Zeichenkette.
 */
function formatMinutes(ms: number | undefined, t: Translate): string {
	if (ms === undefined || ms <= 0) {
		return '';
	}
	const minutes = Math.ceil(ms / 60_000);
	return minutes === 1 ? t('one minute') : t('%s minutes', minutes);
}
