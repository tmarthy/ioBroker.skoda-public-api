/*
 * Created with @iobroker/create-adapter v3.1.5
 */
import * as utils from '@iobroker/adapter-core';
import { SkodaApiClient } from './lib/api/client';
import { readConfig } from './lib/config';
import { AdapterQuotaStore } from './lib/quota/AdapterQuotaStore';
import { QuotaManager } from './lib/quota/QuotaManager';
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

	public constructor(options: Partial<utils.AdapterOptions> = {}) {
		super({
			...options,
			name: 'skoda-public-api',
		});
		this.on('ready', this.onReady.bind(this));
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

		const writer = new StateWriter({ api: this });

		this.scheduler = new PollScheduler({
			client,
			quota,
			vins: settings.vins,
			onVehicleData: (vin, response) => writer.write(vin, response),
			log: this.log,
			onConnectionChange: connected => {
				void this.setState('info.connection', connected, true);
			},
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
	 * Wird beim Herunterfahren gerufen; der Callback muss in jedem Fall laufen.
	 *
	 * @param callback Von ioBroker gestellt.
	 */
	private onUnload(callback: () => void): void {
		try {
			this.scheduler?.stop();
			this.scheduler = undefined;
			callback();
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
