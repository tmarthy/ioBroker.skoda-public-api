/**
 * Zuordnung zwischen den Teilen der Fahrzeugantwort (`include`-Werte) und den
 * Fehlertypen, mit denen die API fehlende Teile in `errors[]` meldet.
 *
 * Die Namen folgen dem Muster `<TEIL>_UNSUPPORTED | _DISABLED | _UNAVAILABLE`,
 * wobei `<TEIL>` nicht immer die Grossschreibung des `include`-Werts ist
 * (`status` -> `VEHICLE_STATUS`). Deshalb steht die Zuordnung hier explizit.
 *
 * Ein Test in parts.test.ts prueft jeden erzeugten Namen gegen die Spec-
 * Beschreibung - so faellt auf, wenn Skoda umbenennt oder ergaenzt.
 */
import type { VehiclePart } from './types';

/** Warum ein Teil der Antwort fehlt. */
export type PartErrorKind = 'UNSUPPORTED' | 'DISABLED' | 'UNAVAILABLE';

/**
 * Praefix des Fehlertyps je Antwortteil. `info` fehlt bewusst: Zu den
 * Basisangaben meldet die API nur `RENDER_UNAVAILABLE`, und zwar ohne dass
 * Name oder Kennzeichen davon betroffen waeren.
 */
const PART_ERROR_PREFIX: Readonly<Record<Exclude<VehiclePart, 'info'>, string>> = {
	status: 'VEHICLE_STATUS',
	fuelStatus: 'FUEL_STATUS',
	odometer: 'ODOMETER',
	parkingPosition: 'PARKING_POSITION',
	airConditioning: 'AIR_CONDITIONING',
	auxiliaryHeating: 'AUXILIARY_HEATING',
	activeVentilation: 'ACTIVE_VENTILATION',
	charging: 'CHARGING',
	chargingProfiles: 'CHARGING_PROFILES',
};

/** Der Fehlertyp, den die API meldet, wenn das Render-Bild fehlt. */
export const RENDER_UNAVAILABLE = 'RENDER_UNAVAILABLE';

/**
 * Baut den Fehlertyp fuer einen Antwortteil.
 *
 * @param part Der Antwortteil, z.B. `charging`.
 * @param kind Warum der Teil fehlt.
 * @returns Der Fehlertyp, z.B. `CHARGING_UNAVAILABLE`.
 */
export function partErrorType(part: Exclude<VehiclePart, 'info'>, kind: PartErrorKind): string {
	return `${PART_ERROR_PREFIX[part]}_${kind}`;
}

/**
 * Findet den Antwortteil zu einem Fehlertyp aus `errors[]`.
 *
 * @param errorType Ein Wert aus `VehicleError.type`.
 * @returns Der betroffene Antwortteil, oder undefined bei unbekannten Typen.
 */
export function partFromErrorType(errorType: string): Exclude<VehiclePart, 'info'> | undefined {
	for (const [part, prefix] of Object.entries(PART_ERROR_PREFIX)) {
		for (const kind of ['UNSUPPORTED', 'DISABLED', 'UNAVAILABLE'] as const) {
			if (errorType === `${prefix}_${kind}`) {
				return part as Exclude<VehiclePart, 'info'>;
			}
		}
	}
	return undefined;
}

/** Alle Antwortteile, die einen eigenen Fehlertyp haben. */
export const ERROR_REPORTING_PARTS = Object.keys(PART_ERROR_PREFIX) as Array<Exclude<VehiclePart, 'info'>>;
