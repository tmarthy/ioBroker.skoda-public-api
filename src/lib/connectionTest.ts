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
import type { QuotaManager } from './quota/QuotaManager';

/** Nur Antworten fuer den aktiven Schluessel duerfen dessen Betriebszustand aendern. */
export interface ConnectionTestTracking {
	/** Schluessel aus dem noch ungespeicherten Formular. */
	testedKey: string;
	/** Schluessel, mit dem die laufende Instanz arbeitet. */
	activeKey: string;
	/** Budget ausschliesslich dieses aktiven Schluessels. */
	quota?: Pick<QuotaManager, 'trackRequest' | 'recordResponse'>;
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
 * @returns Ergebnis samt Text fuer die Admin-UI.
 */
export async function testConnection(
	client: ConnectionTestClient,
	vin: string,
	now: number = Date.now(),
	tracking?: ConnectionTestTracking,
): Promise<ConnectionTestResult> {
	const active = tracking?.testedKey === tracking?.activeKey ? tracking : undefined;
	const permit = active?.quota?.trackRequest();
	const result = await client.getVehicle(vin, ['info']);
	active?.quota?.recordResponse(result.meta, permit);
	await active?.onResponse?.(result.meta);
	if (!result.ok) {
		return { ok: false, text: explainError(result.error, result.meta, now), meta: result.meta };
	}

	const vehicle = result.data.vehicle as unknown as Record<string, unknown>;
	// Name oder Kennzeichen, damit der Nutzer sein Fahrzeug wiedererkennt. Die VIN
	// steht bewusst nicht im Text: Sie ist das eine Datum, das nirgends auftauchen
	// soll (E14), und wer sie gerade eingetippt hat, kennt sie ohnehin.
	const label = [vehicle.name, vehicle.licensePlate].find(
		(value): value is string => typeof value === 'string' && value.length > 0,
	);

	const parts = [`Verbindung steht${label ? ` - ${label}` : ''}.`];
	const expiry = describeKeyExpiry(result.meta, now);
	if (expiry) {
		parts.push(expiry);
	}
	const quota = describeQuota(result.meta);
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
 * @returns Das Ziel, oder die Beanstandung fuer die Admin-UI.
 */
export function pickTestTarget(
	payload: unknown,
	fallback: { apiKey?: string; vins?: unknown },
): ConnectionTestTarget | { problem: string } {
	const data = (payload ?? {}) as Record<string, unknown>;
	const apiKey = (typeof data.apiKey === 'string' ? data.apiKey.trim() : '') || (fallback.apiKey ?? '').trim();
	if (!apiKey) {
		return {
			problem: 'Kein API-Schlüssel eingetragen. Er wird in der MyŠkoda-App unter "API-Schlüssel" erzeugt.',
		};
	}

	const rows = Array.isArray(data.vins) && data.vins.length > 0 ? data.vins : fallback.vins;
	const first = Array.isArray(rows) ? rows[0] : undefined;
	if (first === undefined) {
		return { problem: 'Kein Fahrzeug eingetragen.' };
	}

	const vin = normalizeVin(typeof first === 'string' ? first : (first as { vin?: unknown }).vin);
	if (!vin) {
		return {
			problem:
				'Die erste Zeile der Fahrzeugliste ist keine gültige VIN: 17 Zeichen, ' +
				'Ziffern und Großbuchstaben außer I, O und Q.',
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
 * @returns Der Text fuer die Admin-UI.
 */
function explainError(error: ApiError, meta: ApiMeta, now: number): string {
	switch (error.kind) {
		case 'api-key-expired':
			return 'Der API-Schlüssel ist abgelaufen. In der MyŠkoda-App unter "API-Schlüssel" einen neuen erzeugen.';
		case 'api-key-not-authorized':
			return (
				'Der Schlüssel gilt nicht für diese VIN. Zwei häufige Ursachen: Die VIN ist vertippt, oder das ' +
				'Fahrzeug war beim Erzeugen des Schlüssels in der App nicht ausgewählt.'
			);
		case 'not-found':
			return 'Zu dieser VIN gibt es kein Fahrzeug. Bitte die 17 Zeichen nachsehen.';
		case 'rate-limit-exceeded': {
			const wait = waitMinutes(error.retryAfterMs ?? metaResetMs(meta));
			return `Das Stundenbudget ist erschöpft${wait ? `, in ${wait} wieder versuchen` : ''}. Der Schlüssel selbst ist in Ordnung.`;
		}
		case 'vehicle-not-accepting-requests':
			return 'Das Fahrzeug nimmt gerade keine Anfragen an. Schlüssel und VIN sind in Ordnung; später erneut versuchen.';
		case 'network-error':
			return `Die API war nicht erreichbar: ${error.message}`;
		case 'server-error':
			return `Die API meldet eine Störung: ${error.message}`;
		default:
			return `Der Test ist fehlgeschlagen: ${error.message}${describeExpiryHint(meta, now)}`;
	}
}

/**
 * Ergaenzt einen Hinweis auf den Schluesselablauf, falls die Antwort ihn mitbrachte.
 *
 * @param meta Die Begleitangaben der Antwort.
 * @param now Jetzt-Zeitpunkt in Millisekunden.
 * @returns Der Zusatz, oder eine leere Zeichenkette.
 */
function describeExpiryHint(meta: ApiMeta, now: number): string {
	const expiry = describeKeyExpiry(meta, now);
	return expiry ? ` ${expiry}` : '';
}

/**
 * Beschreibt den Ablauf des Schluessels.
 *
 * @param meta Die Begleitangaben der Antwort.
 * @param now Jetzt-Zeitpunkt in Millisekunden.
 * @returns Der Satz, oder undefined wenn die Antwort nichts dazu sagte.
 */
function describeKeyExpiry(meta: ApiMeta, now: number): string | undefined {
	if (!meta.apiKeyExpiresAt) {
		return undefined;
	}
	const days = Math.floor((meta.apiKeyExpiresAt.getTime() - now) / 86_400_000);
	const date = meta.apiKeyExpiresAt.toISOString().slice(0, 10);
	if (days < 0) {
		return `Der Schlüssel ist seit dem ${date} abgelaufen.`;
	}
	return `Der Schlüssel gilt noch ${days} Tage (bis ${date}).`;
}

/**
 * Beschreibt den Stand des Stundenbudgets.
 *
 * @param meta Die Begleitangaben der Antwort.
 * @returns Der Satz, oder undefined wenn die Header fehlten.
 */
function describeQuota(meta: ApiMeta): string | undefined {
	if (!meta.rateLimit) {
		return undefined;
	}
	const wait = waitMinutes(meta.rateLimit.resetInSeconds * 1000);
	return `Budget: ${meta.rateLimit.remaining} von ${meta.rateLimit.limit} Requests frei, Fenster setzt in ${wait} zurück.`;
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
 * @returns Etwas wie `42 Minuten`, oder eine leere Zeichenkette.
 */
function waitMinutes(ms: number | undefined): string {
	if (ms === undefined || ms <= 0) {
		return '';
	}
	const minutes = Math.ceil(ms / 60_000);
	return minutes === 1 ? 'einer Minute' : `${minutes} Minuten`;
}
