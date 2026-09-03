/**
 * Zuordnung zwischen den vier steuerbaren Domaenen und dem Block der Antwort, aus dem
 * sich ihr Ist-Zustand ablesen laesst.
 *
 * Die Tabelle steht hier und nicht im StateWriter, weil zwei Phasen sie brauchen: Der
 * Writer legt aus ihr die Befehls-States an (Phase 5), die CommandQueue baut aus ihr
 * den Endpunktpfad und entscheidet, ob Soll und Ist auseinanderliegen (Phase 7).
 *
 * **Befehls-States entstehen aus derselben Faehigkeitserkennung wie die Lese-States**
 * (E13/E15): Fehlt der Block in der Antwort, kann das Fahrzeug es nicht, und es wird
 * kein Schalter angelegt. Fuer den Enyaq heisst das vier nutzbare Befehle statt acht -
 * Standheizung und aktive Belueftung liefert er gar nicht erst.
 */
import type { CommandDomain, VehiclePart } from '../api/types';

/** Was eine steuerbare Domaene ausmacht. */
export interface CommandDomainDef {
	/** Domaene im Endpunktpfad, z.B. `air-conditioning`. */
	domain: CommandDomain;
	/** Block der Antwort und damit Kanal im Objektbaum, z.B. `airConditioning`. */
	part: VehiclePart;
	/** Pfad zum Zustandsfeld innerhalb des Blocks. */
	statePath: string;
	/**
	 * Werte, bei denen der Soll-Schalter `true` zeigt (E6).
	 *
	 * `COMPLETED` gehoert bewusst nicht dazu: Eine abgeschlossene Klimatisierung
	 * laeuft nicht mehr. `CONSERVING` und `READY_FOR_CHARGING` ebenso wenig - geladen
	 * wird nur bei `CHARGING`.
	 */
	activeStates: readonly string[];
	/** Name des Soll-Schalters im Objektbaum. */
	label: string;
}

export const COMMAND_DEFS: readonly CommandDomainDef[] = [
	{
		domain: 'charging',
		part: 'charging',
		statePath: 'status.state',
		activeStates: ['CHARGING'],
		label: 'Charging on/off',
	},
	{
		domain: 'air-conditioning',
		part: 'airConditioning',
		statePath: 'state',
		activeStates: ['COOLING', 'HEATING', 'HEATING_AUXILIARY', 'VENTILATION'],
		label: 'Air conditioning on/off',
	},
	{
		domain: 'auxiliary-heating',
		part: 'auxiliaryHeating',
		statePath: 'state',
		activeStates: ['PREHEATING', 'HEATING_AUXILIARY', 'VENTILATION'],
		label: 'Auxiliary heating on/off',
	},
	{
		domain: 'active-ventilation',
		part: 'activeVentilation',
		statePath: 'state',
		activeStates: ['PREHEATING', 'VENTILATION'],
		label: 'Active ventilation on/off',
	},
];

/**
 * Findet die Definition zu einem Antwortblock.
 *
 * @param part Der Block, z.B. `charging`.
 * @returns Die Definition, oder undefined wenn der Block nicht steuerbar ist.
 */
export function commandDefForPart(part: string): CommandDomainDef | undefined {
	return COMMAND_DEFS.find(def => def.part === part);
}
