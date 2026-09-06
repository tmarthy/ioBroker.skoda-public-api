/*
 * Created with @iobroker/create-adapter v3.1.5
 */
import * as utils from '@iobroker/adapter-core';
import { join } from 'node:path';
import { SkodaApiClient } from './lib/api/client';
import { createSanitizer } from './lib/api/sanitize';
import { CommandQueue } from './lib/commands/CommandQueue';
import { readConfig } from './lib/config';
import { pickTestTarget, testConnection } from './lib/connectionTest';
import { AdapterQuotaStore } from './lib/quota/AdapterQuotaStore';
import { VehicleQuotaManager } from './lib/quota/VehicleQuotaManager';
import { KeyExpiryWatcher } from './lib/notifications/keyExpiry';
import { PollScheduler } from './lib/scheduler/PollScheduler';
import { StateWriter } from './lib/states/StateWriter';
import { Lifecycle, ShutdownError } from './lib/lifecycle';
import { createTranslator, translateFallback, type Translate } from './lib/i18n';

/**
 * Der Adapter selbst ist nur die Verdrahtung: Er liest die Konfiguration, baut die
 * vier Schichten zusammen und startet die Schleife.
 *
 * Die Reihenfolge ist keine Geschmacksfrage. Der QuotaManager muss seinen Zustand aus
 * `<vin>.rateLimit.*` zurueckgeholt haben, **bevor** der erste Poll hinausgeht - sonst
 * glaubt eine Instanz in Neustartschleife jedes Mal, sie habe 20 Requests frei.
 */
class SkodaPublicApi extends utils.Adapter {
	private readonly lifecycle = new Lifecycle();
	private readonly clients = new Set<SkodaApiClient>();
	private cleanup?: Promise<void>;
	private scheduler?: PollScheduler;
	private queue?: CommandQueue;
	private quota?: VehicleQuotaManager;
	private keyExpiry?: KeyExpiryWatcher;
	private t: Translate = translateFallback;

	public constructor(options: Partial<utils.AdapterOptions> = {}) {
		super({
			...options,
			name: 'skoda-public-api',
		});
		this.on('ready', () => this.run(() => this.onReady()));
		this.on('stateChange', this.onStateChange.bind(this));
		this.on('message', this.onMessage.bind(this));
		this.on('unload', this.onUnload.bind(this));
	}

	/** Wird gerufen, sobald die Datenbanken verbunden sind und die Konfiguration steht. */
	private async onReady(): Promise<void> {
		this.lifecycle.check();
		const api = this.lifecycle.guard(this);
		await api.setState('info.connection', false, true);
		const configuredLanguage = this.config.backendLanguage;
		const system =
			configuredLanguage === 'de' || configuredLanguage === 'en'
				? undefined
				: await api.getForeignObjectAsync('system.config');
		const t = await createTranslator(
			join(__dirname, '..'),
			configuredLanguage || 'system',
			system?.common.language,
		);
		this.lifecycle.check();
		this.t = t;

		const { settings, problems } = readConfig(this.config, t);
		if (!settings) {
			for (const problem of problems) {
				this.log.error(problem);
			}
			// Kein Abbruch: Der Adapter bleibt als Instanz stehen, damit die
			// Konfiguration in der Admin-UI ergaenzt werden kann. Er fragt nur nichts.
			this.log.error(t('The adapter remains idle until the instance configuration is complete.'));
			return;
		}

		const client = new SkodaApiClient({
			apiKey: settings.apiKey,
			secrets: settings.spin ? [settings.spin] : [],
		});

		this.clients.add(client);

		const quota = new VehicleQuotaManager({
			vins: settings.vins,
			commandReserve: settings.commandReserve,
			storeForVin: vin => new AdapterQuotaStore(api, vin),
			onStoreError: error => {
				if (!(error instanceof ShutdownError)) {
					this.log.warn(t('Quota state could not be saved: %s', String(error)));
				}
			},
		});
		this.quota = quota;
		await quota.start();
		this.lifecycle.check();

		const writer = new StateWriter({ api, t });

		// Der Schluessel erneuert sich nicht von selbst, und sein Ablauf faellt sonst
		// wochenlang nicht auf: Die Werte im Baum bleiben laut E8 ja stehen.
		this.keyExpiry = new KeyExpiryWatcher({
			states: api,
			isStopping: () => this.lifecycle.stopping,
			log: this.log,
			t,
			notify: (category, message) =>
				// Eine gescheiterte Notification darf den Adapter nicht mitreissen: Sie
				// ist die Zugabe, die Logzeile ist die eigentliche Meldung.
				api
					.registerNotification('skoda-public-api', category, message)
					.catch((error: unknown) =>
						this.log.warn(t('Notification "%s" could not be sent: %s', category, String(error))),
					),
		});

		this.scheduler = new PollScheduler({
			client,
			quota,
			vins: settings.vins,
			onVehicleData: async (vin, response) => {
				await writer.write(vin, response);
				// Dieselbe Antwort traegt den Ist-Zustand fuer die Idempotenz und die
				// Zieltemperatur fuer den Koerper von `air-conditioning/start`.
				this.lifecycle.check();
				this.queue?.updateFromResponse(vin, response);
			},
			log: this.log,
			t,
			onConnectionChange: connected => {
				this.run(() => api.setState('info.connection', connected, true));
			},
			onResponse: (meta, error) => this.run(() => this.keyExpiry?.observe(meta, error)),
			intervals: {
				idleMs: settings.idleMs,
				activeMs: settings.activeMs,
				backoffMaxMs: settings.backoffMaxMs,
			},
			readParkingPosition: settings.readParkingPosition,
			// Die Zeitgeber der Adapter-Instanz: Sie werden beim Entladen von
			// ioBroker selbst aufgeraeumt, auch wenn unser stop() einmal nicht liefe.
			setTimer: (handler, ms) => this.setTimeout(handler, ms),
			clearTimer: handle => this.clearTimeout(handle as ioBroker.Timeout),
		});

		this.queue = new CommandQueue({
			client,
			quota,
			vins: settings.vins,
			onReport: (vin, report) => writer.writeCommandResult(vin, report),
			log: this.log,
			t,
			// Die API antwortet auf Befehle mit `202` und kennt keinen Status-Endpunkt:
			// Ob das Fahrzeug den Befehl ausgefuehrt hat, zeigt erst der naechste Poll.
			onCommandSent: vin => this.scheduler?.requestVerificationPoll(vin),
			onConnectionChange: connected => {
				this.run(() => api.setState('info.connection', connected, true));
			},
			onResponse: (meta, error) => this.run(() => this.keyExpiry?.observe(meta, error)),
			ttlMs: settings.commandTtlMs,
			// Der S-PIN kommt aus der Instanzkonfiguration, niemals aus einem State.
			spin: settings.spin || undefined,
			setTimer: (handler, ms) => this.setTimeout(handler, ms),
			clearTimer: handle => this.clearTimeout(handle as ioBroker.Timeout),
		});
		this.queue.start();

		// Nur die Befehls-States, nicht der ganze Baum: Alles zu abonnieren erzeugt
		// Last fuer nichts.
		this.subscribeStates('*.enabled');
		this.subscribeStates('*.start');
		this.subscribeStates('*.stop');

		this.log.info(
			t(
				'%s vehicle(s), polling intervals %s/%s min, command reserve %s of 20 requests per hour and vehicle.',
				settings.vins.length,
				settings.idleMs / 60_000,
				settings.activeMs / 60_000,
				settings.commandReserve,
			),
		);
		if (!settings.readParkingPosition) {
			this.log.info(t('Parking position is disabled and will not be requested.'));
		}
		this.scheduler.start();
	}

	/**
	 * Beantwortet Nachrichten der Admin-UI.
	 *
	 * Bisher gibt es genau eine: den Verbindungstest hinter dem Knopf im
	 * Konfigurationsdialog.
	 *
	 * @param obj Die Nachricht.
	 */
	private onMessage(obj: ioBroker.Message): void {
		if (this.lifecycle.stopping || obj.command !== 'testConnection') {
			return;
		}
		this.run(() => this.answerConnectionTest(obj));
	}

	/**
	 * Fuehrt den Verbindungstest aus und antwortet der Admin-UI.
	 *
	 * Der Test laeuft mit den Werten aus dem Formular, nicht mit den gespeicherten:
	 * Wer gerade einen neuen Schluessel eingetippt hat, will genau den pruefen.
	 *
	 * @param obj Die Nachricht aus der Admin-UI.
	 */
	private async answerConnectionTest(obj: ioBroker.Message): Promise<void> {
		const answer = await this.runConnectionTest(obj.message);
		if (!this.lifecycle.stopping && obj.callback) {
			this.sendTo(obj.from, obj.command, answer, obj.callback);
		}
	}

	/**
	 * Prueft Schluessel und erste VIN mit genau einem Request.
	 *
	 * @param payload Die Werte aus dem Formular.
	 * @returns Die Antwort fuer die Admin-UI.
	 */
	private async runConnectionTest(payload: unknown): Promise<{ result?: string; error?: string }> {
		this.lifecycle.check();
		const t = this.t;
		const target = pickTestTarget(payload, { apiKey: this.config.apiKey, vins: this.config.vins }, t);
		if ('problem' in target) {
			return { error: target.problem };
		}
		const { apiKey, vin } = target;

		const client = new SkodaApiClient({ apiKey, secrets: this.config.spin ? [this.config.spin] : [] });
		this.clients.add(client);
		try {
			// Der Verbindungstest darf auch bei ausgeschoepftem Adapter-Budget bewusst auf
			// Nutzerwunsch laufen. Eine freie Sequenzbuchung sorgt trotzdem dafuer, dass
			// seine spaete Antwort keinen neueren Quota-Stand ueberschreibt.
			const watcher = this.keyExpiry;
			const result = await testConnection(
				client,
				vin,
				Date.now(),
				{
					isStopping: () => this.lifecycle.stopping,
					testedKey: apiKey,
					activeKey: (this.config.apiKey ?? '').trim(),
					quota: this.quota,
					onResponse: meta => watcher?.observe(meta),
				},
				t,
			);
			this.lifecycle.check();
			// Absichtlich ohne den Text: Er nennt Fahrzeugname und Kennzeichen, und die
			// muessen nicht ins Log, das im Forum landet (E14).
			this.log.info(result.ok ? t('Connection test succeeded.') : t('Connection test failed: %s', result.text));
			return result.ok ? { result: result.text } : { error: result.text };
		} finally {
			client.abort();
			this.clients.delete(client);
		}
	}

	/**
	 * Wird gerufen, wenn ein abonnierter Zustand sich aendert.
	 *
	 * Nur Schreibvorgaenge eines Nutzers sind Befehle: Was der Adapter selbst schreibt,
	 * traegt `ack: true` und ist die Quittung, nicht der Auftrag.
	 *
	 * @param id Vollstaendige Zustands-ID.
	 * @param state Der neue Zustand.
	 */
	private onStateChange(id: string, state: ioBroker.State | null | undefined): void {
		if (this.lifecycle.stopping || !state || state.ack) {
			return;
		}
		this.run(() => this.queue?.submit(id.slice(`${this.namespace}.`.length), state.val));
	}

	/**
	 * Wird beim Herunterfahren gerufen; der Callback muss in jedem Fall laufen.
	 *
	 * @param callback Von ioBroker gestellt.
	 */
	private onUnload(callback: () => void): void {
		this.lifecycle.stopping = true;
		this.cleanup ??= this.shutdown();
		void this.cleanup.finally(callback).catch(error => this.cleanupError(error));
	}

	/** Stops admission synchronously, then drains all instance-owned work. */
	private async shutdown(): Promise<void> {
		const actions = [
			() => this.scheduler?.stop(),
			() => this.queue?.stop(),
			...Array.from(this.clients, client => () => client.abort()),
		];
		for (const action of actions) {
			try {
				action();
			} catch (error) {
				this.cleanupError(error);
			}
		}
		const results = await Promise.allSettled([
			this.scheduler?.shutdown(),
			this.queue?.shutdown(),
			this.lifecycle.drain(),
			this.quota?.flush(),
		]);
		for (const result of results) {
			if (result.status === 'rejected') {
				this.cleanupError(result.reason);
			}
		}
		this.clients.clear();
		this.scheduler = undefined;
		this.queue = undefined;
		this.keyExpiry = undefined;
		this.quota = undefined;
	}

	/**
	 * Admits and tracks asynchronous event handlers and callbacks.
	 *
	 * @param work Instance work.
	 */
	private run(work: () => unknown): void {
		this.lifecycle.run(work, error => this.cleanupError(error));
	}

	/**
	 * Logs unexpected lifecycle failures without exposing vehicle identifiers.
	 *
	 * @param error Failure or expected cancellation.
	 */
	private cleanupError(error: unknown): void {
		if (!(error instanceof ShutdownError)) {
			const sanitize = createSanitizer({
				apiKey: this.config.apiKey,
				secrets: this.config.spin ? [this.config.spin] : [],
			});
			this.log.error(this.t('Error during shutdown: %s', sanitize(error)));
		}
	}
}

if (require.main !== module) {
	// Export the constructor in compact mode
	module.exports = (options: Partial<utils.AdapterOptions> | undefined) => new SkodaPublicApi(options);
} else {
	// otherwise start the instance directly
	(() => new SkodaPublicApi())();
}
