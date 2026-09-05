/*
 * Created with @iobroker/create-adapter v3.1.5
 */
import * as utils from '@iobroker/adapter-core';
import { SkodaApiClient } from './lib/api/client';
import { CommandQueue } from './lib/commands/CommandQueue';
import { readConfig } from './lib/config';
import { pickTestTarget, testConnection } from './lib/connectionTest';
import { AdapterQuotaStore } from './lib/quota/AdapterQuotaStore';
import { QuotaManager } from './lib/quota/QuotaManager';
import { KeyExpiryWatcher } from './lib/notifications/keyExpiry';
import { PollScheduler } from './lib/scheduler/PollScheduler';
import { StateWriter } from './lib/states/StateWriter';

/**
 * Der Adapter selbst ist nur die Verdrahtung: Er liest die Konfiguration, baut die
 * vier Schichten zusammen und startet die Schleife.
 *
 * Die Reihenfolge ist keine Geschmacksfrage. Der QuotaManager muss seinen Zustand aus
 * `info.rateLimit.*` zurueckgeholt haben, **bevor** der erste Poll hinausgeht - sonst
 * glaubt eine Instanz in Neustartschleife jedes Mal, sie habe 20 Requests frei.
 */
class SkodaPublicApi extends utils.Adapter {
	private scheduler?: PollScheduler;
	private queue?: CommandQueue;
	private quota?: QuotaManager;
	private keyExpiry?: KeyExpiryWatcher;

	public constructor(options: Partial<utils.AdapterOptions> = {}) {
		super({
			...options,
			name: 'skoda-public-api',
		});
		this.on('ready', this.onReady.bind(this));
		this.on('stateChange', this.onStateChange.bind(this));
		this.on('message', this.onMessage.bind(this));
		this.on('unload', this.onUnload.bind(this));
	}

	/** Wird gerufen, sobald die Datenbanken verbunden sind und die Konfiguration steht. */
	private async onReady(): Promise<void> {
		await this.setState('info.connection', false, true);

		const { settings, problems } = readConfig(this.config);
		if (!settings) {
			for (const problem of problems) {
				this.log.error(problem);
			}
			// Kein Abbruch: Der Adapter bleibt als Instanz stehen, damit die
			// Konfiguration in der Admin-UI ergaenzt werden kann. Er fragt nur nichts.
			this.log.error('Der Adapter bleibt untaetig, bis die Instanzkonfiguration vollstaendig ist.');
			return;
		}

		const client = new SkodaApiClient({
			apiKey: settings.apiKey,
			secrets: settings.spin ? [settings.spin] : [],
		});

		const quota = new QuotaManager({
			commandReserve: settings.commandReserve,
			store: new AdapterQuotaStore(this),
			onStoreError: error => this.log.warn(`Quota-Stand konnte nicht gespeichert werden: ${String(error)}`),
		});
		await quota.start();
		this.quota = quota;

		const writer = new StateWriter({ api: this });

		// Der Schluessel erneuert sich nicht von selbst, und sein Ablauf faellt sonst
		// wochenlang nicht auf: Die Werte im Baum bleiben laut E8 ja stehen.
		this.keyExpiry = new KeyExpiryWatcher({
			states: this,
			log: this.log,
			notify: (category, message) =>
				// Eine gescheiterte Notification darf den Adapter nicht mitreissen: Sie
				// ist die Zugabe, die Logzeile ist die eigentliche Meldung.
				this.registerNotification('skoda-public-api', category, message).catch((error: unknown) =>
					this.log.warn(`Notification "${category}" konnte nicht abgesetzt werden: ${String(error)}`),
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
				this.queue?.updateFromResponse(vin, response);
			},
			log: this.log,
			onConnectionChange: connected => {
				void this.setState('info.connection', connected, true);
			},
			onResponse: (meta, error) => void this.keyExpiry?.observe(meta, error),
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
			// Die API antwortet auf Befehle mit `202` und kennt keinen Status-Endpunkt:
			// Ob das Fahrzeug den Befehl ausgefuehrt hat, zeigt erst der naechste Poll.
			onCommandSent: vin => this.scheduler?.requestVerificationPoll(vin),
			onConnectionChange: connected => {
				void this.setState('info.connection', connected, true);
			},
			onResponse: (meta, error) => void this.keyExpiry?.observe(meta, error),
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
			`${settings.vins.length} Fahrzeug(e), Kadenz ${settings.idleMs / 60_000}/${settings.activeMs / 60_000} min, ` +
				`Befehlsreserve ${settings.commandReserve} von 20 Requests pro Stunde.`,
		);
		if (!settings.readParkingPosition) {
			this.log.info('Parkposition ist abgeschaltet - sie wird gar nicht erst angefordert.');
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
		if (obj.command !== 'testConnection') {
			return;
		}
		void this.answerConnectionTest(obj);
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
		if (obj.callback) {
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
		const target = pickTestTarget(payload, { apiKey: this.config.apiKey, vins: this.config.vins });
		if ('problem' in target) {
			return { error: target.problem };
		}
		const { apiKey, vin } = target;

		const client = new SkodaApiClient({ apiKey, secrets: this.config.spin ? [this.config.spin] : [] });
		// Der Verbindungstest darf auch bei ausgeschoepftem Adapter-Budget bewusst auf
		// Nutzerwunsch laufen. Eine freie Sequenzbuchung sorgt trotzdem dafuer, dass
		// seine spaete Antwort keinen neueren Quota-Stand ueberschreibt.
		const watcher = this.keyExpiry;
		const result = await testConnection(client, vin, Date.now(), {
			testedKey: apiKey,
			activeKey: (this.config.apiKey ?? '').trim(),
			quota: this.quota,
			onResponse: meta => watcher?.observe(meta),
		});
		// Absichtlich ohne den Text: Er nennt Fahrzeugname und Kennzeichen, und die
		// muessen nicht ins Log, das im Forum landet (E14).
		this.log.info(result.ok ? 'Verbindungstest erfolgreich.' : `Verbindungstest fehlgeschlagen: ${result.text}`);
		return result.ok ? { result: result.text } : { error: result.text };
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
		if (!state || state.ack) {
			return;
		}
		void this.queue?.submit(id.slice(`${this.namespace}.`.length), state.val);
	}

	/**
	 * Wird beim Herunterfahren gerufen; der Callback muss in jedem Fall laufen.
	 *
	 * @param callback Von ioBroker gestellt.
	 */
	private onUnload(callback: () => void): void {
		try {
			this.scheduler?.stop();
			this.scheduler = undefined;
			this.queue?.stop();
			this.queue = undefined;
			const quota = this.quota;
			this.quota = undefined;
			this.keyExpiry = undefined;
			if (quota) {
				void quota
					.flush()
					.catch((error: unknown) =>
						this.log.warn(`Quota-Stand beim Entladen nicht gespeichert: ${String(error)}`),
					)
					.finally(callback);
			} else {
				callback();
			}
		} catch (error) {
			this.log.error(`Fehler beim Entladen: ${(error as Error).message}`);
			callback();
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
