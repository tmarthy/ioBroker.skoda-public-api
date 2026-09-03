/**
 * Auswertung der Instanzkonfiguration.
 *
 * Steht als eigenes Modul da, weil sich hier zwei Dinge treffen, die man einzeln
 * pruefen koennen will: die Uebersetzung von Minuten in Millisekunden und die Frage,
 * ob der Adapter ueberhaupt arbeiten kann. Ein Tippfehler in der VIN aeussert sich
 * sonst erst als `403 api-key-not-authorized` - eine Meldung, aus der niemand die
 * Ursache erraet.
 */

/** Die geprueften Einstellungen, in den Einheiten, die der Code braucht. */
export interface AdapterSettings {
	/** Statischer Schluessel aus der MySkoda-App. */
	apiKey: string;
	/** Gross geschriebene, gueltige Fahrgestellnummern, ohne Dubletten. */
	vins: string[];
	/** S-PIN fuer die Standheizung; leer, wenn keiner hinterlegt ist. */
	spin: string;
	/** Grundkadenz in Millisekunden. */
	idleMs: number;
	/** Kadenz beim Laden oder Klimatisieren, in Millisekunden. */
	activeMs: number;
	/** Deckel des Frische-Backoffs in Millisekunden. */
	backoffMaxMs: number;
	/** Requests, die den Befehlen vorbehalten bleiben. */
	commandReserve: number;
	/** Lebensdauer eines wartenden Befehls in Millisekunden. */
	commandTtlMs: number;
	/** Parkposition mitlesen. */
	readParkingPosition: boolean;
}

/** Das Ergebnis der Pruefung. Ohne `settings` darf der Adapter nicht loslegen. */
export interface ConfigResult {
	/** Die geprueften Einstellungen, oder undefined bei einer Beanstandung. */
	settings?: AdapterSettings;
	/** Was fehlt oder falsch ist, in Klartext fuer das Log. */
	problems: string[];
}

/** Eine VIN nach ISO 3779: 17 Zeichen, ohne I, O und Q. */
const VIN_PATTERN = /^[A-HJ-NPR-Z0-9]{17}$/;

const DEFAULTS = {
	pollIntervalIdle: 15,
	pollIntervalActive: 5,
	pollBackoffMax: 60,
	commandReserve: 6,
	commandTtl: 10,
} as const;

/**
 * Liest eine Zahl aus der Konfiguration.
 *
 * @param value Der Rohwert.
 * @param fallback Vorgabe, wenn nichts Brauchbares dasteht.
 * @param min Untergrenze.
 * @param max Obergrenze.
 * @returns Die Zahl innerhalb der Grenzen.
 */
function number(value: unknown, fallback: number, min: number, max: number): number {
	// Zahlen kommen aus manchen Formularen als Zeichenkette; alles andere ist nichts.
	const parsed = typeof value === 'number' ? value : typeof value === 'string' ? Number.parseFloat(value) : NaN;
	if (!Number.isFinite(parsed)) {
		return fallback;
	}
	return Math.min(max, Math.max(min, parsed));
}

/**
 * Holt die Liste der Fahrgestellnummern aus der Konfiguration.
 *
 * Die Admin-UI liefert eine Tabelle mit `vin` je Zeile; von Hand geschriebene
 * Konfigurationen enthalten oft schlicht Zeichenketten. Beides wird angenommen.
 *
 * @param raw Der Rohwert des Feldes `vins`.
 * @param problems Sammelstelle fuer Beanstandungen.
 * @returns Die gueltigen, gross geschriebenen VINs ohne Dubletten.
 */
function readVins(raw: unknown, problems: string[]): string[] {
	if (!Array.isArray(raw) || raw.length === 0) {
		problems.push('Keine Fahrgestellnummer konfiguriert - der Adapter kann kein Fahrzeug abfragen.');
		return [];
	}

	const vins: string[] = [];
	raw.forEach((entry, index) => {
		const value = typeof entry === 'string' ? entry : (entry as { vin?: unknown } | null)?.vin;
		const vin = typeof value === 'string' ? value.trim().toUpperCase() : '';
		if (!VIN_PATTERN.test(vin)) {
			// Die fehlerhafte VIN steht bewusst nicht in der Meldung: Sie ist meist
			// die echte mit einem Tippfehler, und das Log landet im Forum (E14).
			problems.push(
				`Zeile ${index + 1} der Fahrzeugliste ist keine gueltige VIN ` +
					'(17 Zeichen, Ziffern und Grossbuchstaben ausser I, O und Q).',
			);
			return;
		}
		if (!vins.includes(vin)) {
			vins.push(vin);
		}
	});
	return vins;
}

/**
 * Prueft die Instanzkonfiguration und rechnet sie in Millisekunden um.
 *
 * @param raw `this.config` der Adapter-Instanz.
 * @returns Die Einstellungen, oder die Liste der Beanstandungen.
 */
export function readConfig(raw: unknown): ConfigResult {
	const config = (raw ?? {}) as Record<string, unknown>;
	const problems: string[] = [];

	const apiKey = typeof config.apiKey === 'string' ? config.apiKey.trim() : '';
	if (!apiKey) {
		problems.push(
			'Kein API-Schluessel konfiguriert - er wird in der MySkoda-App erzeugt (Menue "API-Schluessel").',
		);
	}

	const vins = readVins(config.vins, problems);
	if (problems.length > 0) {
		return { problems };
	}

	// Die Untergrenzen stehen im Plan, Phase 6. Sie gelten auch fuer eine von Hand
	// geschriebene Konfiguration - 20 Requests pro Stunde verzeihen keinen Tippfehler.
	const idle = number(config.pollIntervalIdle, DEFAULTS.pollIntervalIdle, 5, 240);
	const active = number(config.pollIntervalActive, DEFAULTS.pollIntervalActive, 3, 240);

	return {
		problems,
		settings: {
			apiKey,
			vins,
			spin: typeof config.spin === 'string' ? config.spin.trim() : '',
			idleMs: idle * 60_000,
			activeMs: active * 60_000,
			backoffMaxMs: number(config.pollBackoffMax, DEFAULTS.pollBackoffMax, idle, 24 * 60) * 60_000,
			commandReserve: Math.round(number(config.commandReserve, DEFAULTS.commandReserve, 0, 15)),
			commandTtlMs: number(config.commandTtl, DEFAULTS.commandTtl, 1, 60) * 60_000,
			readParkingPosition: config.readParkingPosition !== false,
		},
	};
}
