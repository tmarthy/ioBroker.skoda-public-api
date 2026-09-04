/*
 * PV-Ueberschussladen fuer ioBroker.skoda-public-api
 * ==================================================
 *
 * Vorlage fuer den ioBroker-JavaScript-Adapter. **Kein fertiges Produkt**: Die
 * State-IDs der PV-Anlage und die Schwellen muss jeder selbst setzen - genau deshalb
 * steht diese Logik hier und nicht im Adapter (siehe docs/design-decisions.md, E4).
 *
 * Was dieses Skript beachtet, und warum:
 *
 * 1. **Die API kann den Ladestrom nicht setzen.** Geregelt wird nur ein/aus
 *    (Bang-Bang). Damit das ueberhaupt zum Ueberschuss passt, muss der AC-Ladestrom
 *    in der MySkoda-App auf REDUCED stehen - sonst zieht das Fahrzeug mehr, als eine
 *    kleine Anlage je liefert.
 * 2. **20 Requests pro Stunde.** Jeder Schaltvorgang kostet zwei davon (Befehl plus
 *    Verifikations-Poll). Deshalb: Hysterese, Verzoegerungen, Mindestlaufzeiten und
 *    eine harte Obergrenze fuer Schaltvorgaenge pro Stunde.
 * 3. **`ack: true` heisst "an die API uebergeben"**, nicht "das Auto laedt jetzt".
 *    Ob es geklappt hat, steht erst im naechsten Poll - dieses Skript liest deshalb
 *    den Ist-Zustand aus `charging.status.state` und nicht aus seinem eigenen Wunsch.
 */

// ---------------------------------------------------------------------------
// Einstellungen - hier anpassen
// ---------------------------------------------------------------------------
const CONFIG = {
	/** Instanz und Fahrzeug. */
	instance: 'skoda-public-api.0',
	vin: 'TMBJB9NY5RF999999',

	/**
	 * Der Ueberschuss in Watt: was gerade ins Netz ginge, wenn nicht geladen wird.
	 * Bei manchen Zaehlern ist das der negative Netzbezug - dann hier umrechnen.
	 */
	surplusState: 'javascript.0.pv.surplusWatts',

	/**
	 * Einschalten ab diesem Ueberschuss. Richtwert: die tatsaechliche Ladeleistung
	 * des Fahrzeugs plus etwas Reserve. An einem Enyaq mit REDUCED wurden 5 kW
	 * gemessen - nachsehen unter `<vin>.charging.status.chargePowerInKw`.
	 */
	onWatts: 5000,
	/** Ausschalten, wenn der Ueberschuss darunter faellt. Abstand = Hysterese. */
	offWatts: 3500,

	/** Wie lange die Schwelle gehalten werden muss, bevor geschaltet wird. */
	onDelayMs: 5 * 60 * 1000,
	offDelayMs: 10 * 60 * 1000,

	/** Mindestlaufzeiten, damit eine Wolke keinen Schaltzyklus ausloest. */
	minOnMs: 20 * 60 * 1000,
	minOffMs: 20 * 60 * 1000,

	/** Harte Obergrenze: mehr Schaltvorgaenge passen nicht ins Stundenbudget. */
	maxSwitchesPerHour: 4,

	/**
	 * Nur laden, wenn das Fahrzeug zuhause steht. Leer lassen, um darauf zu
	 * verzichten. `isVehicleInSavedLocation` ist dafuer **unbrauchbar** - der Wert
	 * springt; besser ein eigener Geofence auf `parkingPosition.position`.
	 */
	atHomeState: '',
};

// ---------------------------------------------------------------------------
// Abgeleitete IDs
// ---------------------------------------------------------------------------
const BASE = `${CONFIG.instance}.${CONFIG.vin}`;
const ID = {
	enabled: `${BASE}.charging.enabled`,
	chargingState: `${BASE}.charging.status.state`,
	plugged: `${BASE}.charging.status.state`,
	soc: `${BASE}.charging.status.battery.stateOfChargeInPercent`,
	lastCommandResult: `${BASE}.info.lastCommand.result`,
	lastCommandName: `${BASE}.info.lastCommand.name`,
	dataAge: `${BASE}.info.dataAge`,
};

/** Zustaende, in denen das Fahrzeug am Kabel haengt, aber nicht laedt. */
const READY_STATES = ['READY_FOR_CHARGING', 'CONSERVING', 'CHARGING_INTERRUPTED'];

// ---------------------------------------------------------------------------
// Laufender Zustand
// ---------------------------------------------------------------------------
let aboveSince = null; // seit wann liegt der Ueberschuss ueber der Einschaltschwelle
let belowSince = null; // seit wann darunter
let lastSwitchAt = 0; // wann zuletzt geschaltet wurde
const switchTimestamps = []; // Schaltvorgaenge der letzten Stunde

/**
 * Liest eine Zahl aus einem State, ohne bei fehlendem State zu stolpern.
 *
 * @param {string} id State-ID.
 * @returns {number|null} Der Wert, oder null.
 */
function numberOf(id) {
	const state = getState(id);
	return state && typeof state.val === 'number' ? state.val : null;
}

/**
 * Der Ist-Zustand des Ladens, wie ihn der letzte Poll gesehen hat.
 *
 * @returns {string|null} Der Ladezustand, oder null.
 */
function chargingState() {
	const state = getState(ID.chargingState);
	return state && typeof state.val === 'string' ? state.val : null;
}

/**
 * Steckt das Kabel? Ohne Kabel ist jeder Befehl verschwendetes Budget.
 *
 * @returns {boolean} True, wenn geladen werden koennte oder wird.
 */
function isPluggedIn() {
	const state = chargingState();
	return state === 'CHARGING' || READY_STATES.includes(state);
}

/**
 * Wie viele Schaltvorgaenge in der letzten Stunde stattfanden.
 *
 * @returns {number} Anzahl.
 */
function switchesInLastHour() {
	const cutoff = Date.now() - 3600 * 1000;
	while (switchTimestamps.length > 0 && switchTimestamps[0] < cutoff) {
		switchTimestamps.shift();
	}
	return switchTimestamps.length;
}

/**
 * Setzt den Soll-Zustand, wenn alle Sperren es zulassen.
 *
 * Der Adapter selbst prueft noch einmal, ob Soll und Ist auseinanderliegen, und
 * verwirft den Befehl sonst als COALESCED. Dieses Skript soll ihn aber gar nicht
 * erst schicken - jeder unnoetige Befehl kostet zwei Requests.
 *
 * @param {boolean} desired Gewuenschter Zustand.
 * @param {string} reason Begruendung fuer das Log.
 */
function requestCharging(desired, reason) {
	const actual = chargingState() === 'CHARGING';
	if (actual === desired) {
		return;
	}

	const sinceLastSwitch = Date.now() - lastSwitchAt;
	const minimum = desired ? CONFIG.minOffMs : CONFIG.minOnMs;
	if (lastSwitchAt > 0 && sinceLastSwitch < minimum) {
		return;
	}

	if (switchesInLastHour() >= CONFIG.maxSwitchesPerHour) {
		log(
			`PV: ${reason}, aber die Obergrenze von ${CONFIG.maxSwitchesPerHour} Schaltvorgaengen pro Stunde ist erreicht.`,
			'warn',
		);
		return;
	}

	log(`PV: ${desired ? 'starte' : 'stoppe'} das Laden - ${reason}.`);
	lastSwitchAt = Date.now();
	switchTimestamps.push(lastSwitchAt);
	setState(ID.enabled, desired, false); // ack: false - das ist der Auftrag
}

/**
 * Prueft bei jeder Aenderung des Ueberschusses, ob geschaltet werden soll.
 *
 * @param {number} surplus Der Ueberschuss in Watt.
 */
function evaluate(surplus) {
	if (!isPluggedIn()) {
		aboveSince = null;
		belowSince = null;
		return;
	}

	if (CONFIG.atHomeState && getState(CONFIG.atHomeState)?.val !== true) {
		return;
	}

	const now = Date.now();

	if (surplus >= CONFIG.onWatts) {
		belowSince = null;
		aboveSince = aboveSince ?? now;
		if (now - aboveSince >= CONFIG.onDelayMs) {
			requestCharging(
				true,
				`${Math.round(surplus)} W Ueberschuss seit ${Math.round((now - aboveSince) / 60000)} min`,
			);
		}
		return;
	}

	if (surplus <= CONFIG.offWatts) {
		aboveSince = null;
		belowSince = belowSince ?? now;
		if (now - belowSince >= CONFIG.offDelayMs) {
			requestCharging(false, `nur noch ${Math.round(surplus)} W Ueberschuss`);
		}
		return;
	}

	// Zwischen den Schwellen: nichts tun. Das ist die Hysterese.
	aboveSince = null;
	belowSince = null;
}

// ---------------------------------------------------------------------------
// Verdrahtung
// ---------------------------------------------------------------------------
on({ id: CONFIG.surplusState, change: 'any' }, obj => {
	if (typeof obj.state?.val === 'number') {
		evaluate(obj.state.val);
	}
});

// Das Ergebnis jedes Befehls mitlesen. COALESCED und QUEUED sind Normalbetrieb,
// alles andere will man wissen.
on({ id: ID.lastCommandResult, change: 'any', ack: true }, obj => {
	const result = obj.state?.val;
	const name = getState(ID.lastCommandName)?.val;
	if (result === 'SENT' || result === 'COALESCED' || result === 'QUEUED') {
		return;
	}
	log(`PV: Befehl ${name} endete mit ${result}. Siehe das Adapter-Log.`, 'warn');
});

// Beim Start einmal auswerten, damit nach einem Neustart nicht bis zur naechsten
// Aenderung gewartet wird.
const initial = numberOf(CONFIG.surplusState);
if (initial !== null) {
	evaluate(initial);
}

log(
	`PV-Ueberschussladen aktiv: ein ab ${CONFIG.onWatts} W (${CONFIG.onDelayMs / 60000} min), ` +
		`aus unter ${CONFIG.offWatts} W (${CONFIG.offDelayMs / 60000} min), ` +
		`hoechstens ${CONFIG.maxSwitchesPerHour} Schaltvorgaenge pro Stunde.`,
);
