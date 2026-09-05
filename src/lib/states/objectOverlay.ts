/**
 * Handgepflegte Ergaenzung zu objectDefs.generated.ts.
 *
 * Die OpenAPI-Spec kennt Datentypen und Aufzaehlungswerte, aber keine ioBroker-Rollen,
 * keine Einheiten und keine lesbaren Labels. Genau das steht hier. Beide Quellen werden
 * zur Laufzeit in `resolveCommon()` zusammengefuehrt - so kann der Codegen jederzeit neu
 * laufen, ohne handgepflegte Werte zu ueberschreiben (siehe docs/design-decisions.md, E7).
 *
 * Aufloesungsreihenfolge: Anzeigeumrechnung > exakter Pfad > Endungsregel > Generat.
 */
import type { GeneratedStateDef } from './objectDefs.generated';

/** Handgepflegte Zusatzangaben zu einem Zustand, die die OpenAPI-Spec nicht hergibt. */
export interface OverlayEntry {
	/** ioBroker-Rolle, z.B. `value.battery` oder `sensor.door`. */
	role?: string;
	/** Anzeigeeinheit, z.B. `%`, `kW` oder `km`. */
	unit?: string;
	/** Untere Plausibilitaetsgrenze, von der Admin-UI und VIS ausgewertet. */
	min?: number;
	/** Obere Plausibilitaetsgrenze. */
	max?: number;
	/** Lesbare Labels fuer Aufzaehlungswerte. Fehlende Werte bleiben roh. */
	labels?: Record<string, string>;
}

const PERCENT: OverlayEntry = { role: 'value.battery', unit: '%', min: 0, max: 100 };

/** Anzeigeumrechnung eines API-Werts; die State-ID bleibt aus Kompatibilitaetsgruenden bestehen. */
interface DisplayConversion {
	/** Teiler fuer den unveraenderten numerischen API-Wert. */
	divisor: number;
	/** Einheit des umgerechneten Werts. */
	unit: string;
	/** Beschreibung mit der Anzeigeeinheit statt der API-Einheit. */
	name: string;
}

/** Nur ausdruecklich bekannte API-Felder umrechnen, keine Einheiten anhand unbekannter Namen erraten. */
export const displayConversions: Readonly<Record<string, DisplayConversion>> = {
	'charging.status.battery.remainingCruisingRangeInMeters': {
		divisor: 1000,
		unit: 'km',
		name: 'Remaining cruising range with HV battery power in kilometers.',
	},
	'activeVentilation.durationInSeconds': {
		divisor: 60,
		unit: 'min',
		name: 'Duration in minutes the active ventilation runs for when started.',
	},
	'auxiliaryHeating.durationInSeconds': {
		divisor: 60,
		unit: 'min',
		name: 'Duration in minutes the auxiliary heating runs for when started.',
	},
};

/**
 * Endungsregeln greifen auf jeden Pfad, der so endet. Reihenfolge ist bedeutsam:
 * die erste passende Regel gewinnt, deshalb stehen spezifische Endungen oben.
 */
const suffixOverlay: ReadonlyArray<readonly [string, OverlayEntry]> = [
	// Ladezustand und Reichweite
	['stateOfChargeInPercent', PERCENT],
	['currentSoCInPercent', PERCENT],
	['currentFuelLevelInPercent', { role: 'value.fill', unit: '%', min: 0, max: 100 }],
	['targetStateOfChargeInPercent', PERCENT],
	['batteryCareModeTargetValueInPercent', PERCENT],
	['chargePowerInKw', { role: 'value.power', unit: 'kW' }],
	['chargingRateInKilometersPerHour', { role: 'value.speed', unit: 'km/h' }],
	['maxChargeCurrentAcAmpere', { role: 'value.current', unit: 'A' }],
	['remainingCruisingRangeInMeters', { role: 'value.distance', unit: 'm' }],
	['remainingRangeInKm', { role: 'value.distance', unit: 'km' }],
	['totalRangeInKm', { role: 'value.distance', unit: 'km' }],
	['adBlueRange', { role: 'value.distance', unit: 'km' }],
	['mileageInKm', { role: 'value.distance', unit: 'km' }],
	['remainingTimeToFullyChargedInMinutes', { role: 'value.interval', unit: 'min' }],
	['durationInSeconds', { role: 'value.interval', unit: 's' }],

	// Zeitpunkte - bleiben als ISO-8601-Zeichenkette, wie die API sie liefert (E7).
	['carCapturedTimestamp', { role: 'date' }],
	['fullyChargedAt', { role: 'date' }],
	['estimatedReachOfTargetTemperatureAt', { role: 'date' }],
	['nextChargingTime', { role: 'date' }],

	// Position
	['gpsCoordinates.latitude', { role: 'value.gps.latitude', unit: '°' }],
	['gpsCoordinates.longitude', { role: 'value.gps.longitude', unit: '°' }],
	['formattedAddress', { role: 'text' }],
];

const exactOverlay: Readonly<Record<string, OverlayEntry>> = {
	vin: { role: 'text' },
	name: { role: 'text' },
	licensePlate: { role: 'text' },
	renderUrl: { role: 'url' },

	'status.overall.doorsLocked': {
		role: 'sensor.lock',
		labels: {
			YES: 'Locked',
			NO: 'Unlocked',
			OPENED: 'Door open',
			TRUNK_OPENED: 'Trunk open',
			UNKNOWN: 'Unknown',
		},
	},
	'status.overall.locked': {
		role: 'sensor.lock',
		labels: { YES: 'Locked', NO: 'Unlocked', UNKNOWN: 'Unknown' },
	},
	'status.overall.reliableLockStatus': { role: 'sensor.lock' },
	'status.overall.doors': { role: 'sensor.door' },
	'status.overall.windows': { role: 'sensor.window' },
	'status.overall.lights': { role: 'sensor.light' },
	'status.detail.sunroof': { role: 'sensor.window' },
	'status.detail.trunk': { role: 'sensor.door' },
	'status.detail.bonnet': { role: 'sensor.door' },

	'charging.status.state': {
		role: 'text',
		labels: {
			CONNECT_CABLE: 'Cable not connected',
			READY_FOR_CHARGING: 'Ready for charging',
			CHARGING: 'Charging',
			CONSERVING: 'Conserving',
			CHARGING_INTERRUPTED: 'Charging interrupted',
			DISCHARGING: 'Discharging',
		},
	},
	'charging.status.chargeType': { role: 'text' },
	'charging.isVehicleInSavedLocation': { role: 'indicator' },
	'charging.settings.availableChargeModes': { role: 'json' },

	'airConditioning.state': {
		role: 'text',
		labels: {
			OFF: 'Off',
			COOLING: 'Cooling',
			HEATING: 'Heating',
			HEATING_AUXILIARY: 'Auxiliary heating',
			VENTILATION: 'Ventilation',
			COMPLETED: 'Completed',
			UNKNOWN: 'Unknown',
			UNSUPPORTED: 'Not supported',
		},
	},
	// Einheit bewusst offen: die Skala steht im Geschwisterzustand `targetTemperature.unit`
	// (CELSIUS oder FAHRENHEIT). Der StateWriter setzt sie zur Laufzeit daraus.
	'airConditioning.targetTemperature.value': { role: 'value.temperature' },
	'auxiliaryHeating.targetTemperature.value': { role: 'value.temperature' },
	'airConditioning.airConditioningAtUnlock': { role: 'indicator' },
	'airConditioning.airConditioningWithoutExternalPower': { role: 'indicator' },
	'airConditioning.windowHeating.enabled': { role: 'indicator' },
	'airConditioning.windowHeating.front': { role: 'sensor.heat' },
	'airConditioning.windowHeating.rear': { role: 'sensor.heat' },

	'parkingPosition.state': {
		role: 'text',
		labels: { IN_MOTION: 'In motion', PARKED: 'Parked' },
	},

	'chargingProfiles.profiles': { role: 'json' },
};

/** Alle exakt adressierten Overlay-Pfade - fuer den Konsistenztest gegen das Generat. */
export const exactOverlayPaths: readonly string[] = Object.keys(exactOverlay);

function lookupOverlay(path: string): OverlayEntry | undefined {
	const exact = exactOverlay[path];
	if (exact) {
		return exact;
	}
	for (const [suffix, entry] of suffixOverlay) {
		if (path === suffix || path.endsWith(`.${suffix}`)) {
			return entry;
		}
	}
	return undefined;
}

/**
 * Fallback-Rolle, wenn weder Overlay noch Spec etwas Besseres hergeben.
 *
 * @param def Die aus der Spec erzeugte Zustandsdefinition.
 * @returns Eine ioBroker-Rolle, die zum Datentyp passt.
 */
function defaultRole(def: GeneratedStateDef): string {
	if (def.arrayOf || def.isJsonArray) {
		return 'json';
	}
	if (def.format === 'date-time') {
		return 'date';
	}
	if (def.type === 'boolean') {
		return 'indicator';
	}
	if (def.states) {
		return 'text';
	}
	return def.type === 'number' ? 'value' : 'text';
}

/**
 * Fuehrt Generat und Overlay zu einem ioBroker-`common` zusammen.
 * Alle gespiegelten Zustaende sind ausschliesslich lesend - Befehle sind
 * eigene Objekte und entstehen nicht aus der Spec (E6, E15).
 *
 * @param path Punktpfad relativ zum Geraeteknoten, z.B. `charging.status.state`.
 * @param def Die aus der Spec erzeugte Zustandsdefinition.
 * @returns Das fertige `common` fuer `setObjectNotExists`.
 */
export function resolveCommon(path: string, def: GeneratedStateDef): ioBroker.StateCommon {
	const overlay = lookupOverlay(path);

	const common: ioBroker.StateCommon = {
		name: def.desc ?? path,
		type: def.type,
		role: overlay?.role ?? defaultRole(def),
		read: true,
		write: false,
	};

	if (overlay?.unit !== undefined) {
		common.unit = overlay.unit;
	}
	if (overlay?.min !== undefined) {
		common.min = overlay.min;
	}
	if (overlay?.max !== undefined) {
		common.max = overlay.max;
	}

	if (def.states) {
		// Unbekannte Werte bleiben roh stehen - so ueberlebt der Adapter neue
		// Aufzaehlungswerte, die Skoda laut Spec ausdruecklich nachschieben darf.
		common.states = Object.fromEntries(
			Object.keys(def.states).map(value => [value, overlay?.labels?.[value] ?? value]),
		);
	}
	const conversion = displayConversions[path];
	if (conversion) {
		common.unit = conversion.unit;
		common.name = conversion.name;
	}

	return common;
}
