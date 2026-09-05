/**
 * Mock der MyŠkoda Public API.
 *
 * Das ist nicht bloss Testzubehoer, sondern das Entwicklungssystem: Gegen die echte
 * API laesst sich nicht arbeiten, weil 20 Requests pro Stunde nach zwanzig Minuten
 * Debugging aufgebraucht sind (siehe docs/design-decisions.md, E12).
 *
 * Der Mock bildet deshalb genau die Eigenschaften nach, die im Adapter Logik ausloesen:
 * die `RateLimit-*`-Buchhaltung samt der Regel, welche Antworten Quota verbrauchen,
 * den Ablauf des API-Schluessels, die Fehlerfamilien aus der Spec, Teilausfaelle in
 * `errors[]` und die Tatsache, dass ein Befehl mit `202` beantwortet wird und erst ein
 * spaeterer GET zeigt, ob das Fahrzeug ihn ausgefuehrt hat.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { partErrorType } from '../../src/lib/api/parts';
import { VEHICLE_PARTS, type VehiclePart } from '../../src/lib/api/types';

export const PROBLEM_BASE = 'https://public.api.connect.skoda-auto.cz/problems';
export const DEFAULT_API_KEY = 'mock-api-key';
export const DEFAULT_VIN = 'TMBJB9NY5RF999999';
const FIXTURE_DIR = path.join(__dirname, '..', 'fixtures');

/** Was der Mock als Naechstes antworten soll. `ok` bedeutet Normalbetrieb. */
export type MockScenario =
	| 'ok'
	| 'partial-data'
	| 'api-key-expired'
	| 'api-key-not-authorized'
	| 'operation-not-authorized'
	| 'operation-not-supported'
	| 'operation-disabled'
	| 'rate-limit-exceeded'
	| 'vehicle-not-accepting-requests'
	| 'not-found'
	| 'server-error'
	| 'service-unavailable'
	| 'gateway-timeout';

interface ProblemSpec {
	status: number;
	type: string;
	title: string;
	detail: string;
	retryAfterSeconds?: number;
	/** Nur diese Antworten lassen die Quota unberuehrt (401, 403, 429). */
	consumesQuota: boolean;
}

const PROBLEMS: Readonly<Record<Exclude<MockScenario, 'ok' | 'partial-data'>, ProblemSpec>> = {
	'api-key-expired': {
		status: 401,
		type: `${PROBLEM_BASE}/api-key-expired`,
		title: 'Unauthorized',
		detail: 'The API key expired on 2026-09-01T00:00:00Z.',
		consumesQuota: false,
	},
	'api-key-not-authorized': {
		status: 403,
		type: `${PROBLEM_BASE}/api-key-not-authorized`,
		title: 'Forbidden',
		detail: 'The API key is not authorized for this vehicle.',
		consumesQuota: false,
	},
	'operation-not-authorized': {
		status: 403,
		type: `${PROBLEM_BASE}/operation-not-authorized`,
		title: 'Forbidden',
		detail: 'The vehicle refused the operation for this user.',
		consumesQuota: true,
	},
	'operation-not-supported': {
		status: 422,
		type: `${PROBLEM_BASE}/operation-not-supported`,
		title: 'Unprocessable Entity',
		detail: 'The vehicle lacks the capability this operation needs.',
		consumesQuota: true,
	},
	'operation-disabled': {
		status: 422,
		type: `${PROBLEM_BASE}/operation-disabled`,
		title: 'Unprocessable Entity',
		detail: 'The capability is currently disabled for this vehicle.',
		consumesQuota: true,
	},
	'rate-limit-exceeded': {
		status: 429,
		type: `${PROBLEM_BASE}/rate-limit-exceeded`,
		title: 'Too Many Requests',
		detail: 'The rate limit for the API key has been exceeded.',
		retryAfterSeconds: 900,
		consumesQuota: false,
	},
	'vehicle-not-accepting-requests': {
		status: 429,
		type: `${PROBLEM_BASE}/vehicle-not-accepting-requests`,
		title: 'Too Many Requests',
		detail: 'The vehicle declined the operation and it can be retried later.',
		retryAfterSeconds: 120,
		consumesQuota: false,
	},
	'not-found': {
		status: 404,
		type: 'about:blank',
		title: 'Not Found',
		detail: 'No vehicle found for the given VIN.',
		consumesQuota: true,
	},
	'server-error': {
		status: 500,
		type: 'about:blank',
		title: 'Internal Server Error',
		detail: 'Unexpected internal application error.',
		consumesQuota: true,
	},
	'service-unavailable': {
		status: 503,
		type: 'about:blank',
		title: 'Service Unavailable',
		detail: 'The API key could not be validated.',
		retryAfterSeconds: 30,
		consumesQuota: true,
	},
	'gateway-timeout': {
		status: 504,
		type: 'about:blank',
		title: 'Gateway Timeout',
		detail: 'Operation timeout.',
		consumesQuota: true,
	},
};

/** Wirkung eines Befehls auf den Fahrzeugzustand, sichtbar beim naechsten GET. */
const COMMAND_EFFECTS: Readonly<Record<string, (vehicle: any) => void>> = {
	'charging/start': v => {
		v.charging.status.state = 'CHARGING';
		v.charging.status.chargeType = 'AC';
		v.charging.status.chargePowerInKw = 10.8;
	},
	'charging/stop': v => {
		v.charging.status.state = 'READY_FOR_CHARGING';
		v.charging.status.chargeType = 'OFF';
		v.charging.status.chargePowerInKw = 0;
	},
	'air-conditioning/start': v => {
		v.airConditioning.state = 'HEATING';
	},
	'air-conditioning/stop': v => {
		v.airConditioning.state = 'OFF';
	},
	'active-ventilation/start': v => {
		v.activeVentilation.state = 'VENTILATION';
	},
	'active-ventilation/stop': v => {
		v.activeVentilation.state = 'OFF';
	},
	'auxiliary-heating/start': v => {
		v.auxiliaryHeating.state = 'HEATING_AUXILIARY';
	},
	'auxiliary-heating/stop': v => {
		v.auxiliaryHeating.state = 'OFF';
	},
};

/** Welcher Block der Antwort zu welcher Befehlsdomaene gehoert. */
const DOMAIN_TO_PART: Readonly<Record<string, Exclude<VehiclePart, 'info'>>> = {
	charging: 'charging',
	'air-conditioning': 'airConditioning',
	'auxiliary-heating': 'auxiliaryHeating',
	'active-ventilation': 'activeVentilation',
};

/** Zu `include=info` gehoeren die Basisangaben, nicht ein eigener Block. */
const INFO_FIELDS = ['name', 'licensePlate', 'renderUrl'] as const;

export interface MockOptions {
	apiKey?: string;
	vin?: string;
	/** Dateiname unter test/fixtures ohne Praefix und Endung, z.B. 'synth-idle'. */
	fixture?: string;
	rateLimit?: number;
	windowSeconds?: number;
	keyExpiresInDays?: number;
	/** Verzoegerung, bis ein Befehl im Fahrzeugzustand sichtbar wird. */
	commandLatencyMs?: number;
	/** Ersetzbare Zeitquelle, damit Tests das Quota-Fenster vorspulen koennen. */
	now?: () => number;
}

export interface MockRequestLog {
	method: string;
	path: string;
	at: number;
	status: number;
	consumedQuota: boolean;
}

/**
 * Ein Fehler, der in `errors[]` gemeldet werden soll, statt den Request scheitern
 * zu lassen. Entspricht dem Fall "200, aber unvollstaendig" aus der Doku.
 */
export interface PartFailure {
	part: Exclude<VehiclePart, 'info'>;
	kind: 'UNSUPPORTED' | 'DISABLED' | 'UNAVAILABLE';
}

export class MockSkodaApi {
	/** Naechste Antwort. Wird nach jedem Request NICHT zurueckgesetzt. */
	public scenario: MockScenario = 'ok';
	/** Teile, die im Szenario 'partial-data' fehlen und in `errors[]` erscheinen. */
	public partFailures: PartFailure[] = [{ part: 'charging', kind: 'UNAVAILABLE' }];
	public readonly requests: MockRequestLog[] = [];

	private server?: Server;
	private port = 0;
	private vehicle: any;
	private readonly options: Required<Omit<MockOptions, 'fixture'>> & {
		fixture: string;
	};
	private remaining: number;
	private windowStartedAt: number;
	private pendingEffects: Array<{
		dueAt: number;
		apply: () => void;
	}> = [];

	public constructor(options: MockOptions = {}) {
		this.options = {
			apiKey: options.apiKey ?? DEFAULT_API_KEY,
			vin: options.vin ?? DEFAULT_VIN,
			fixture: options.fixture ?? 'idle',
			rateLimit: options.rateLimit ?? 20,
			windowSeconds: options.windowSeconds ?? 3600,
			keyExpiresInDays: options.keyExpiresInDays ?? 90,
			commandLatencyMs: options.commandLatencyMs ?? 0,
			now: options.now ?? (() => Date.now()),
		};
		this.remaining = this.options.rateLimit;
		this.windowStartedAt = this.options.now();
		this.loadFixture(this.options.fixture);
	}

	/**
	 * Startet den Server.
	 *
	 * @param port Port, 0 waehlt einen freien - in Tests der Normalfall.
	 * @returns Die Basis-URL, z.B. `http://127.0.0.1:53124`.
	 */
	public start(port = 0): Promise<string> {
		return new Promise((resolve, reject) => {
			this.server = createServer((req, res) => {
				try {
					this.handle(req, res);
				} catch (error: unknown) {
					res.writeHead(500, { 'Content-Type': 'text/plain' });
					res.end(String(error));
				}
			});
			this.server.once('error', reject);
			this.server.listen(port, '127.0.0.1', () => {
				const address = this.server?.address();
				this.port = typeof address === 'object' && address ? address.port : port;
				resolve(this.baseUrl);
			});
		});
	}

	/** Haelt den Server an. Mehrfaches Aufrufen ist ungefaehrlich. */
	public stop(): Promise<void> {
		return new Promise(resolve => {
			if (!this.server) {
				resolve();
				return;
			}
			this.server.close(() => resolve());
			this.server = undefined;
		});
	}

	public get baseUrl(): string {
		return `http://127.0.0.1:${this.port}`;
	}

	/** Aktueller Stand der Quota, wie ihn die Header melden wuerden. */
	public get quota(): {
		limit: number;
		remaining: number;
		resetInSeconds: number;
	} {
		this.refreshWindow();
		const elapsed = (this.options.now() - this.windowStartedAt) / 1000;
		return {
			limit: this.options.rateLimit,
			remaining: this.remaining,
			resetInSeconds: Math.max(0, Math.ceil(this.options.windowSeconds - elapsed)),
		};
	}

	/**
	 * Laedt ein Fixture als aktuellen Fahrzeugzustand.
	 *
	 * @param name Dateiname ohne `vehicle-` und ohne `.json`.
	 */
	public loadFixture(name: string): void {
		const file = path.join(FIXTURE_DIR, `vehicle-${name}.json`);
		const fixture = JSON.parse(readFileSync(file, 'utf8'));
		this.vehicle = structuredClone(fixture.body.vehicle);
		this.vehicle.vin = this.options.vin;
	}

	/** Setzt Quota, Verlauf, Szenario und ausstehende Befehlswirkungen zurueck. */
	public reset(): void {
		this.remaining = this.options.rateLimit;
		this.windowStartedAt = this.options.now();
		this.requests.length = 0;
		this.pendingEffects = [];
		this.scenario = 'ok';
		this.loadFixture(this.options.fixture);
	}

	/** Liefert den aktuellen, vom Mock gepflegten Fahrzeugzustand (fuer Zusicherungen). */
	public get vehicleState(): any {
		return this.vehicle;
	}

	private refreshWindow(): void {
		const elapsedMs = this.options.now() - this.windowStartedAt;
		if (elapsedMs >= this.options.windowSeconds * 1000) {
			this.remaining = this.options.rateLimit;
			this.windowStartedAt = this.options.now();
		}
	}

	private applyDueEffects(): void {
		const now = this.options.now();
		const due = this.pendingEffects.filter(e => e.dueAt <= now);
		this.pendingEffects = this.pendingEffects.filter(e => e.dueAt > now);
		for (const effect of due) {
			effect.apply();
		}
	}

	private rateLimitHeaders(): Record<string, string> {
		const q = this.quota;
		return {
			'RateLimit-Limit': String(q.limit),
			'RateLimit-Remaining': String(q.remaining),
			'RateLimit-Reset': String(q.resetInSeconds),
		};
	}

	private keyExpiresAt(): string {
		return new Date(this.options.now() + this.options.keyExpiresInDays * 86_400_000).toISOString();
	}

	private send(
		res: ServerResponse,
		req: IncomingMessage,
		status: number,
		body: unknown,
		options: {
			consumesQuota: boolean;
			contentType?: string;
			retryAfterSeconds?: number;
		},
	): void {
		if (options.consumesQuota) {
			this.remaining = Math.max(0, this.remaining - 1);
		}

		const headers: Record<string, string> = {
			'Content-Type': options.contentType ?? 'application/json',
			...this.rateLimitHeaders(),
		};
		if (status < 400) {
			headers['X-API-Key-Expires-At'] = this.keyExpiresAt();
		}
		if (options.retryAfterSeconds !== undefined) {
			headers['Retry-After'] = String(options.retryAfterSeconds);
		}

		this.requests.push({
			method: req.method ?? 'GET',
			path: req.url ?? '/',
			at: this.options.now(),
			status,
			consumedQuota: options.consumesQuota,
		});

		res.writeHead(status, headers);
		res.end(body === undefined ? '' : JSON.stringify(body));
	}

	private sendProblem(res: ServerResponse, req: IncomingMessage, spec: ProblemSpec, instance: string): void {
		this.send(
			res,
			req,
			spec.status,
			{
				type: spec.type,
				title: spec.title,
				status: spec.status,
				detail: spec.detail,
				instance,
			},
			{
				consumesQuota: spec.consumesQuota,
				contentType: 'application/problem+json',
				retryAfterSeconds: spec.retryAfterSeconds,
			},
		);
	}

	private handle(req: IncomingMessage, res: ServerResponse): void {
		const url = new URL(req.url ?? '/', this.baseUrl);
		this.refreshWindow();
		this.applyDueEffects();

		// Steuerschnittstelle fuer den Standalone-Betrieb. Nicht Teil der echten API,
		// deshalb ausserhalb jeder Quota- und Schluesselpruefung.
		if (url.pathname === '/__mock' || url.pathname.startsWith('/__mock/')) {
			this.handleControl(url, res);
			return;
		}

		const apiKey = req.headers['x-api-key'];
		if (typeof apiKey !== 'string' || apiKey.length === 0) {
			this.sendProblem(
				res,
				req,
				{
					status: 401,
					type: 'about:blank',
					title: 'Unauthorized',
					detail: 'Missing X-API-Key header.',
					consumesQuota: false,
				},
				url.pathname,
			);
			return;
		}
		if (this.scenario === 'api-key-expired') {
			this.sendProblem(res, req, PROBLEMS['api-key-expired'], url.pathname);
			return;
		}
		if (apiKey !== this.options.apiKey) {
			this.sendProblem(res, req, PROBLEMS['api-key-not-authorized'], url.pathname);
			return;
		}

		const match = /^\/api\/v1\/vehicles\/([^/]+)(?:\/([^/]+)\/(start|stop))?$/.exec(url.pathname);
		if (!match) {
			this.sendProblem(res, req, PROBLEMS['not-found'], url.pathname);
			return;
		}
		const [, vin, domain, action] = match;

		if (vin !== this.options.vin) {
			this.sendProblem(res, req, PROBLEMS['api-key-not-authorized'], url.pathname);
			return;
		}

		if (this.scenario !== 'ok' && this.scenario !== 'partial-data') {
			this.sendProblem(res, req, PROBLEMS[this.scenario], url.pathname);
			return;
		}

		// Erst jetzt greift das Budget: 401 und 403 kosten laut Doku nichts.
		if (this.remaining <= 0) {
			this.sendProblem(res, req, PROBLEMS['rate-limit-exceeded'], url.pathname);
			return;
		}

		if (domain && action) {
			this.handleCommand(req, res, url, domain, action);
			return;
		}
		if (req.method !== 'GET') {
			this.sendProblem(res, req, PROBLEMS['not-found'], url.pathname);
			return;
		}
		this.handleGetVehicle(req, res, url);
	}

	private handleControl(url: URL, res: ServerResponse): void {
		const send = (body: unknown): void => {
			res.writeHead(200, { 'Content-Type': 'application/json' });
			res.end(JSON.stringify(body));
		};
		switch (url.pathname) {
			case '/__mock/scenario': {
				const next = url.searchParams.get('value');
				if (next) {
					this.scenario = next as MockScenario;
				}
				send({ scenario: this.scenario });
				return;
			}
			case '/__mock/fixture': {
				const name = url.searchParams.get('value');
				if (name) {
					this.loadFixture(name);
				}
				send({ fixture: name ?? this.options.fixture });
				return;
			}
			case '/__mock/reset':
				this.reset();
				send({ ok: true, quota: this.quota });
				return;
			default:
				send({ scenario: this.scenario, quota: this.quota, requests: this.requests.length });
		}
	}

	private handleGetVehicle(req: IncomingMessage, res: ServerResponse, url: URL): void {
		const raw = url.searchParams.getAll('include').flatMap(v => v.split(','));
		const requested = raw.map(v => v.trim()).filter(v => v.length > 0);

		const unknown = requested.find(v => !VEHICLE_PARTS.includes(v as VehiclePart));
		if (unknown) {
			this.send(
				res,
				req,
				400,
				{
					type: 'about:blank',
					title: 'Bad Request',
					status: 400,
					detail: `Unknown include value '${unknown}'.`,
					instance: url.pathname,
					parameter: 'include',
					rejectedValue: unknown,
					allowedValues: VEHICLE_PARTS,
				},
				{ consumesQuota: true, contentType: 'application/problem+json' },
			);
			return;
		}

		const errors: Array<{
			type: string;
			description: string;
		}> = [];
		const failing = new Set(this.scenario === 'partial-data' ? this.partFailures.map(f => f.part) : []);
		if (this.scenario === 'partial-data') {
			for (const failure of this.partFailures) {
				errors.push({
					type: partErrorType(failure.part, failure.kind),
					description: `Mock: ${failure.part} is ${failure.kind.toLowerCase()}.`,
				});
			}
		}

		const vehicle: Record<string, unknown> = { vin: this.vehicle.vin };
		const wanted: VehiclePart[] =
			requested.length > 0 ? (requested as VehiclePart[]) : (VEHICLE_PARTS as readonly VehiclePart[]).slice();

		for (const part of wanted) {
			if (part === 'info') {
				for (const field of INFO_FIELDS) {
					if (this.vehicle[field] !== undefined) {
						vehicle[field] = this.vehicle[field];
					}
				}
				continue;
			}
			if (failing.has(part)) {
				continue;
			}

			if (this.vehicle[part] === undefined) {
				// Nur ausdruecklich angeforderte Teile werden als nicht unterstuetzt gemeldet -
				// ohne `include` fehlen sie schlicht. Genau das ist die Faehigkeitserkennung.
				if (requested.length > 0) {
					errors.push({
						type: partErrorType(part, 'UNSUPPORTED'),
						description: `Mock: vehicle does not support ${part}.`,
					});
				}
				continue;
			}
			vehicle[part] = this.vehicle[part];
		}

		// Ohne `include` gehoeren die Basisangaben immer dazu.
		if (requested.length === 0) {
			for (const field of INFO_FIELDS) {
				if (this.vehicle[field] !== undefined) {
					vehicle[field] = this.vehicle[field];
				}
			}
		}

		// Die echte API laesst `errors` bei einer fehlerfreien Antwort **ganz weg** -
		// sie sendet kein leeres Array.
		// Wuerde der Mock hier immer ein Array liefern, waere er nachsichtiger als die
		// Wirklichkeit und ein `body.errors.map(...)` bestuende jeden Test und schluege
		// erst im Betrieb fehl.
		const body = errors.length > 0 ? { vehicle, errors } : { vehicle };
		this.send(res, req, 200, body, { consumesQuota: true });
	}

	private handleCommand(req: IncomingMessage, res: ServerResponse, url: URL, domain: string, action: string): void {
		if (req.method !== 'POST') {
			this.sendProblem(res, req, PROBLEMS['not-found'], url.pathname);
			return;
		}
		const key = `${domain}/${action}`;
		const effect = COMMAND_EFFECTS[key];
		const part = DOMAIN_TO_PART[domain];
		if (!effect || !part) {
			this.sendProblem(res, req, PROBLEMS['not-found'], url.pathname);
			return;
		}

		// Fehlt der Block im Fixture, kann das Fahrzeug es nicht - genau der Fall,
		// den ein Enyaq bei der Standheizung liefert.
		if (this.vehicle[part] === undefined) {
			this.sendProblem(res, req, PROBLEMS['operation-not-supported'], url.pathname);
			return;
		}

		const apply = (): void => {
			effect(this.vehicle);
			const stamp = new Date(this.options.now()).toISOString();
			for (const block of ['status', 'charging', 'airConditioning', 'auxiliaryHeating', 'activeVentilation']) {
				if (this.vehicle[block]?.carCapturedTimestamp !== undefined) {
					this.vehicle[block].carCapturedTimestamp = stamp;
				}
			}
		};

		if (this.options.commandLatencyMs > 0) {
			this.pendingEffects.push({ dueAt: this.options.now() + this.options.commandLatencyMs, apply });
		} else {
			apply();
		}

		this.send(res, req, 202, undefined, { consumesQuota: true });
	}
}
