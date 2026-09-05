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
	/** Deutscher Anzeigename des Soll-Schalters. */
	labelDe: string;
}

export const COMMAND_DEFS: readonly CommandDomainDef[] = [
	{
		domain: 'charging',
		part: 'charging',
		statePath: 'status.state',
		activeStates: ['CHARGING'],
		label: 'Charging on/off',
		labelDe: 'Laden ein/aus',
	},
	{
		domain: 'air-conditioning',
		part: 'airConditioning',
		statePath: 'state',
		activeStates: ['COOLING', 'HEATING', 'HEATING_AUXILIARY', 'VENTILATION'],
		label: 'Air conditioning on/off',
		labelDe: 'Klimatisierung ein/aus',
	},
	{
		domain: 'auxiliary-heating',
		part: 'auxiliaryHeating',
		statePath: 'state',
		activeStates: ['PREHEATING', 'HEATING_AUXILIARY', 'VENTILATION'],
		label: 'Auxiliary heating on/off',
		labelDe: 'Standheizung ein/aus',
	},
	{
		domain: 'active-ventilation',
		part: 'activeVentilation',
		statePath: 'state',
		activeStates: ['PREHEATING', 'VENTILATION'],
		label: 'Active ventilation on/off',
		labelDe: 'Aktive Belüftung ein/aus',
	},
];

/**
 * Wie ein Befehl ausgegangen ist (E5).
 *
 * `FAILED` steht nicht in E5. Es ist trotzdem noetig: Ein `500`, ein `400` oder ein
 * Netzwerkfehler ist weder eine Ablehnung durch das Fahrzeug noch ein Verfall, und wer
 * so etwas als `EXPIRED` meldet, schickt jeden auswertenden Skript-Autor an die
 * falsche Stelle.
 */
export type CommandResult = 'SENT' | 'QUEUED' | 'COALESCED' | 'EXPIRED' | 'REJECTED_BY_VEHICLE' | 'FAILED';

/** Alle Ergebnisse mit ihrer Bedeutung - fuer `common.states` des Zustands. */
export const COMMAND_RESULTS: Readonly<Record<CommandResult, string>> = {
	SENT: 'Handed over to the API',
	QUEUED: 'Waiting for quota',
	COALESCED: 'Dropped, target state already reached',
	EXPIRED: 'Dropped, time to live exceeded',
	REJECTED_BY_VEHICLE: 'Rejected by the vehicle',
	FAILED: 'Failed, see log',
};

/** Was nach `<vin>.info.lastCommand.*` geschrieben wird. */
export interface CommandReport {
	/** Der Befehl, z.B. `charging.start`. */
	name: string;
	/** Wie er ausgegangen ist. */
	result: CommandResult;
	/** Zeitpunkt in Millisekunden seit Epoch. */
	timestamp: number;
	/** Problemtyp der API, sofern einer kam. */
	problemType?: string;
	/**
	 * Der ausloesende Zustand samt Wert, der quittiert werden soll.
	 *
	 * `ack: true` heisst hier **an die API uebergeben**, nicht "das Auto hat es getan" -
	 * mehr weiss der Adapter wegen `202` ohne Status-Endpunkt nicht (E6).
	 */
	acknowledge?: { path: string; value: boolean };
}

/**
 * Findet die Definition zu einem Antwortblock.
 *
 * @param part Der Block, z.B. `charging`.
 * @returns Die Definition, oder undefined wenn der Block nicht steuerbar ist.
 */
export function commandDefForPart(part: string): CommandDomainDef | undefined {
	return COMMAND_DEFS.find(def => def.part === part);
}
