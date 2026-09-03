import { expect } from 'chai';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import {
	PROBLEM_SLUGS,
	classify,
	consumesQuotaForStatus,
	httpApiError,
	networkApiError,
	parseProblemDetail,
	parseRetryAfter,
	problemSlug,
	unexpectedResponseError,
	type ApiErrorKind,
} from './errors';
import { SECRET_PLACEHOLDER, VIN_PLACEHOLDER, createSanitizer } from './sanitize';

const PROBLEM_BASE = 'https://public.api.connect.skoda-auto.cz/problems';
const VIN = 'TMBJB9NY5RF999999';

/** Eine Zeile der Fehlertabelle aus docs/implementation-plan.md, Abschnitt 5. */
interface TableRow {
	label: string;
	status: number;
	/** Problemtyp als Kurzform; fehlt, wenn die API `about:blank` sendet. */
	slug?: string;
	kind: ApiErrorKind;
	consumesQuota: boolean;
	retryable: boolean;
	maxRetries: number;
}

/**
 * Die Fehlertabelle, Zeile fuer Zeile. Sie ist die Spezifikation dieser Schicht -
 * steht hier absichtlich noch einmal als Literal, damit ein Tippfehler in errors.ts
 * nicht zusammen mit dem Test wandert.
 */
const TABLE: TableRow[] = [
	{
		label: '400 Bad Request',
		status: 400,
		kind: 'bad-request',
		consumesQuota: true,
		retryable: false,
		maxRetries: 0,
	},
	{
		label: '401 api-key-expired',
		status: 401,
		slug: 'api-key-expired',
		kind: 'api-key-expired',
		consumesQuota: false,
		retryable: false,
		maxRetries: 0,
	},
	{
		label: '403 api-key-not-authorized',
		status: 403,
		slug: 'api-key-not-authorized',
		kind: 'api-key-not-authorized',
		consumesQuota: false,
		retryable: false,
		maxRetries: 0,
	},
	{
		label: '403 operation-not-authorized',
		status: 403,
		slug: 'operation-not-authorized',
		kind: 'operation-not-authorized',
		consumesQuota: true,
		retryable: false,
		maxRetries: 0,
	},
	{
		label: '404 Not Found',
		status: 404,
		kind: 'not-found',
		consumesQuota: true,
		retryable: false,
		maxRetries: 0,
	},
	{
		label: '422 operation-not-supported',
		status: 422,
		slug: 'operation-not-supported',
		kind: 'operation-not-supported',
		consumesQuota: true,
		retryable: false,
		maxRetries: 0,
	},
	{
		label: '422 operation-disabled',
		status: 422,
		slug: 'operation-disabled',
		kind: 'operation-disabled',
		consumesQuota: true,
		retryable: false,
		maxRetries: 0,
	},
	{
		label: '429 rate-limit-exceeded',
		status: 429,
		slug: 'rate-limit-exceeded',
		kind: 'rate-limit-exceeded',
		consumesQuota: false,
		retryable: true,
		maxRetries: Number.POSITIVE_INFINITY,
	},
	{
		label: '429 vehicle-not-accepting-requests',
		status: 429,
		slug: 'vehicle-not-accepting-requests',
		kind: 'vehicle-not-accepting-requests',
		consumesQuota: false,
		retryable: true,
		maxRetries: 3,
	},
	{ label: '500', status: 500, kind: 'server-error', consumesQuota: true, retryable: true, maxRetries: 1 },
	{ label: '503', status: 503, kind: 'server-error', consumesQuota: true, retryable: true, maxRetries: 1 },
	{ label: '504', status: 504, kind: 'server-error', consumesQuota: true, retryable: true, maxRetries: 1 },
];

/**
 * Baut einen Antwortkoerper nach problem+json.
 *
 * @param status HTTP-Status.
 * @param slug Problemtyp als Kurzform, oder undefined fuer `about:blank`.
 * @returns Der Koerper als Zeichenkette, wie ihn die API sendet.
 */
function problemBody(status: number, slug?: string): string {
	return JSON.stringify({
		type: slug ? `${PROBLEM_BASE}/${slug}` : 'about:blank',
		title: 'Testtitel',
		status,
		detail: 'Testdetail',
		instance: `/api/v1/vehicles/${VIN}`,
	});
}

describe('api/errors => problem+json als diskriminierte Union', () => {
	describe('Fehlertabelle, Zeile fuer Zeile', () => {
		for (const row of TABLE) {
			it(`ordnet "${row.label}" richtig ein`, () => {
				const error = httpApiError({ status: row.status, body: problemBody(row.status, row.slug) });
				expect(error.kind, 'kind').to.equal(row.kind);
				expect(error.status, 'status').to.equal(row.status);
				expect(error.consumesQuota, 'consumesQuota').to.equal(row.consumesQuota);
				expect(error.retryable, 'retryable').to.equal(row.retryable);
				expect(error.maxRetries, 'maxRetries').to.equal(row.maxRetries);
			});
		}

		it('zaehlt 202 Accepted als verbraucht - der Befehl kostet einen Request', () => {
			expect(consumesQuotaForStatus(202)).to.equal(true);
			expect(consumesQuotaForStatus(200)).to.equal(true);
		});

		it('zaehlt einen Netzwerkfehler konservativ als verbraucht', () => {
			// Der Verbrauch ist in Wahrheit unbekannt: Die Antwort kann unterwegs
			// verloren gegangen sein, nachdem der Server sie gebucht hat.
			const error = networkApiError(new TypeError('fetch failed'));
			expect(error.kind).to.equal('network-error');
			expect(error.status).to.equal(undefined);
			expect(error.consumesQuota).to.equal(true);
			expect(error.retryable).to.equal(true);
			expect(error.maxRetries).to.equal(1);
		});

		it('erkennt die Zeitueberschreitung von AbortSignal.timeout()', () => {
			const abort = new Error('The operation was aborted due to timeout');
			abort.name = 'TimeoutError';
			expect(networkApiError(abort).timeout).to.equal(true);
			expect(networkApiError(new TypeError('fetch failed')).timeout).to.equal(false);
		});
	});

	describe('Unterscheidung am Problemtyp', () => {
		it('trennt die beiden 429 nur am type, nicht am Status', () => {
			const quota = httpApiError({ status: 429, body: problemBody(429, 'rate-limit-exceeded') });
			const vehicle = httpApiError({ status: 429, body: problemBody(429, 'vehicle-not-accepting-requests') });
			expect(quota.status).to.equal(vehicle.status);
			expect(quota.kind).to.not.equal(vehicle.kind);
			// Beide kosten nichts, aber nur einer darf beliebig oft warten.
			expect(quota.maxRetries).to.equal(Number.POSITIVE_INFINITY);
			expect(vehicle.maxRetries).to.equal(3);
		});

		it('trennt die beiden 403 - und nur einer davon kostet Quota', () => {
			const key = httpApiError({ status: 403, body: problemBody(403, 'api-key-not-authorized') });
			const operation = httpApiError({ status: 403, body: problemBody(403, 'operation-not-authorized') });
			expect(key.consumesQuota).to.equal(false);
			expect(operation.consumesQuota).to.equal(true);
		});

		it('vergleicht nur das letzte Pfadsegment, nicht den Hostnamen', () => {
			expect(problemSlug('https://irgendwo.example/problems/api-key-expired')).to.equal('api-key-expired');
			expect(problemSlug('about:blank')).to.equal(undefined);
			expect(problemSlug(undefined)).to.equal(undefined);
			expect(problemSlug(`${PROBLEM_BASE}/etwas-neues`)).to.equal(undefined);
		});

		it('kennt jeden Problemtyp, den die Spec beschreibt', () => {
			const specText = readFileSync(path.join(__dirname, '..', '..', '..', 'spec', 'skoda-openapi.json'), 'utf8');
			for (const slug of PROBLEM_SLUGS) {
				expect(specText, `${slug} steht nicht in der Spec`).to.contain(`${PROBLEM_BASE}/${slug}`);
			}
		});
	});

	describe('Antworten, die in keine Zeile passen', () => {
		it('meldet einen unbekannten Status als unexpected und wiederholt nicht', () => {
			const error = httpApiError({ status: 418, body: '' });
			expect(error.kind).to.equal('unexpected');
			expect(error.retryable).to.equal(false);
			expect(error.consumesQuota).to.equal(true);
		});

		it('folgt beim Auffangfall der allgemeinen Regel: 401, 403 und 429 kosten nichts', () => {
			expect(httpApiError({ status: 401, body: '' }).consumesQuota).to.equal(false);
			expect(httpApiError({ status: 403, body: '' }).consumesQuota).to.equal(false);
			expect(httpApiError({ status: 429, body: '' }).consumesQuota).to.equal(false);
			expect(httpApiError({ status: 418, body: '' }).consumesQuota).to.equal(true);
		});

		it('haelt HTML von einem Proxy aus und behaelt den Status', () => {
			const error = httpApiError({ status: 502, body: '<html><body>Bad Gateway</body></html>' });
			expect(error.kind).to.equal('server-error');
			expect(error.status).to.equal(502);
			expect(error.message).to.contain('Bad Gateway');
			expect(error.problemType).to.equal(undefined);
		});

		it('kuerzt einen ausufernden Fremdkoerper', () => {
			const error = httpApiError({ status: 500, body: 'x'.repeat(5000) });
			expect(error.message.length).to.be.lessThan(400);
		});

		it('meldet eine unbrauchbare Erfolgsantwort als unexpected', () => {
			const error = unexpectedResponseError(200, 'Antwort ohne Fahrzeugdaten');
			expect(error.kind).to.equal('unexpected');
			expect(error.status).to.equal(200);
			expect(error.consumesQuota).to.equal(true);
			expect(error.retryable).to.equal(false);
		});

		it('erkennt leere und kaputte Koerper, ohne zu werfen', () => {
			expect(parseProblemDetail('')).to.equal(undefined);
			expect(parseProblemDetail('kein json')).to.equal(undefined);
			expect(parseProblemDetail('[1,2,3]')).to.equal(undefined);
			expect(parseProblemDetail('{"unbekannt":1}')).to.equal(undefined);
			expect(parseProblemDetail('{"title":"Da"}')).to.deep.equal({ title: 'Da' });
		});

		it('uebernimmt nur Felder mit dem erwarteten Typ', () => {
			const parsed = parseProblemDetail('{"type":42,"title":"Da","status":"403"}');
			expect(parsed).to.deep.equal({ title: 'Da' });
		});

		it('klassifiziert ohne Koerper allein nach dem Status', () => {
			expect(classify(400)).to.equal('bad-request');
			expect(classify(404)).to.equal('not-found');
			expect(classify(500)).to.equal('server-error');
			expect(classify(403)).to.equal('unexpected');
		});
	});

	describe('Retry-After', () => {
		it('liest Sekunden', () => {
			expect(parseRetryAfter('900')).to.equal(900_000);
			expect(parseRetryAfter(' 30 ')).to.equal(30_000);
		});

		it('liest ein HTTP-Datum nach Millisekunden statt es zu vergleichen', () => {
			const now = Date.parse('2026-09-03T18:00:00Z');
			expect(parseRetryAfter('Thu, 03 Sep 2026 18:02:00 GMT', now)).to.equal(120_000);
			// Ein Zeitpunkt in der Vergangenheit heisst "sofort", nicht "negativ warten".
			expect(parseRetryAfter('Thu, 03 Sep 2026 17:58:00 GMT', now)).to.equal(0);
		});

		it('meldet einen fehlenden oder unbrauchbaren Header als undefined', () => {
			expect(parseRetryAfter(null)).to.equal(undefined);
			expect(parseRetryAfter(undefined)).to.equal(undefined);
			expect(parseRetryAfter('')).to.equal(undefined);
			expect(parseRetryAfter('bald')).to.equal(undefined);
		});

		it('uebernimmt die Wartezeit in den Fehler', () => {
			const error = httpApiError({
				status: 429,
				body: problemBody(429, 'rate-limit-exceeded'),
				retryAfterMs: 900_000,
			});
			expect(error.retryAfterMs).to.equal(900_000);
		});
	});

	describe('Maskierung', () => {
		it('maskiert VIN und Schluessel in jedem uebernommenen Feld', () => {
			const key = 'sk-live-4f2a9c7e1b8d';
			const error = httpApiError({
				status: 403,
				body: JSON.stringify({
					type: `${PROBLEM_BASE}/api-key-not-authorized`,
					title: `Schluessel ${key}`,
					detail: `Fahrzeug ${VIN} nicht freigegeben, Schluessel ${key}`,
					instance: `/api/v1/vehicles/${VIN}`,
				}),
				sanitizer: createSanitizer({ apiKey: key }),
			});
			const dump = JSON.stringify(error);
			expect(dump).to.not.contain(VIN);
			expect(dump).to.not.contain(key);
			expect(error.detail).to.contain(VIN_PLACEHOLDER).and.to.contain(SECRET_PLACEHOLDER);
			expect(error.message).to.contain(VIN_PLACEHOLDER);
		});

		it('maskiert auch ohne uebergebene Geheimnisse wenigstens die VIN', () => {
			const error = httpApiError({ status: 404, body: problemBody(404) });
			expect(JSON.stringify(error)).to.not.contain(VIN);
		});

		it('maskiert die Ursache eines Netzwerkfehlers', () => {
			const error = networkApiError(new Error(`getaddrinfo ENOTFOUND ${VIN}.example`));
			expect(error.message).to.not.contain(VIN);
			expect(error.message).to.contain('ENOTFOUND');
		});
	});
});
