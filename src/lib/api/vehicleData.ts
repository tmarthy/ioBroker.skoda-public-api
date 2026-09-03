/**
 * Auswertungen auf einer Fahrzeugantwort, die mehr als eine Schicht braucht.
 *
 * Der StateWriter rechnet daraus `info.dataAge`, der PollScheduler seinen
 * Frische-Backoff und die gelernte `include`-Liste. Die Funktionen stehen deshalb
 * hier unten bei den Typen und nicht in einer der beiden Schichten - sonst muesste
 * eine von beiden die andere kennen.
 */
import { VEHICLE_PARTS, type VehiclePart } from './types';

/** Felder, die zum `include`-Wert `info` gehoeren. */
const INFO_FIELDS = ['name', 'licensePlate', 'renderUrl'] as const;

/**
 * Sucht den juengsten `carCapturedTimestamp` im Antwortbaum.
 *
 * Geparst wird nach Millisekunden und nicht als Zeichenkette verglichen: An den
 * Zeitstempeln dieser API haengen 0, 2, 3 oder 9 Nachkommastellen, je nach Block.
 * Ein Vergleich der Zeichenketten waere damit unzuverlaessig - und genau dieser
 * Vergleich traegt den Frische-Backoff in Phase 6.
 *
 * @param node Ein Teilbaum der Antwort.
 * @returns Der juengste Zeitpunkt in Millisekunden, oder undefined.
 */
export function newestCapturedAt(node: Record<string, unknown>): number | undefined {
	let newest: number | undefined;
	for (const [key, value] of Object.entries(node)) {
		if (key === 'carCapturedTimestamp' && typeof value === 'string') {
			const at = Date.parse(value);
			if (!Number.isNaN(at) && (newest === undefined || at > newest)) {
				newest = at;
			}
			continue;
		}
		if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
			const nested = newestCapturedAt(value as Record<string, unknown>);
			if (nested !== undefined && (newest === undefined || nested > newest)) {
				newest = nested;
			}
		}
	}
	return newest;
}

/**
 * Liest ab, welche Teile das Fahrzeug tatsaechlich geliefert hat.
 *
 * Das ist die eingebaute Faehigkeitserkennung (E13): Ohne `include` liefert die API
 * genau die Teile, die das Fahrzeug unterstuetzt - schweigend, ohne Fehlermeldung.
 *
 * @param vehicle Die Fahrzeugdaten der Antwort.
 * @returns Die enthaltenen Teile in der Reihenfolge von `VEHICLE_PARTS`.
 */
export function detectParts(vehicle: Record<string, unknown>): VehiclePart[] {
	const found: VehiclePart[] = [];
	for (const part of VEHICLE_PARTS) {
		if (part === 'info') {
			if (INFO_FIELDS.some(field => vehicle[field] !== undefined)) {
				found.push(part);
			}
			continue;
		}
		const value = vehicle[part];
		if (value !== null && value !== undefined && typeof value === 'object') {
			found.push(part);
		}
	}
	return found;
}
