/**
 * Von der Zustands-ID zum Endpunkt und zum Koerper des Requests.
 *
 * Der Objektbaum spiegelt die Antwort der API (E7), die Befehlsendpunkte heissen aber
 * anders als ihre Bloecke: `airConditioning` im Baum, `air-conditioning` im Pfad. Diese
 * Uebersetzung steht in `commandDefs.ts`; hier steht, wie aus einem Schreibvorgang ein
 * Befehl wird.
 *
 * Zwei Wege fuehren zu einem Befehl (E6):
 * - `<vin>.<block>.enabled` traegt den **Soll-Zustand**. Entspricht er dem Ist, wird
 *   nichts gesendet - das ist die Idempotenz, die eine Bang-Bang-Regelung braucht.
 * - `<vin>.<block>.start` und `.stop` sind Knoepfe und **erzwingen** den Aufruf. Sie
 *   sind der Ausweg, wenn die zuletzt gepollten Daten nicht mehr stimmen.
 */
import type {
	CommandAction,
	StartAirConditioningConfiguration,
	StartAuxiliaryHeatingConfiguration,
} from '../api/types';
import {
	CHARGING_LIMIT_DEF,
	CHARGING_LIMIT_PATH,
	commandDefForPart,
	type CommandDomainDef,
} from '../states/commandDefs';

/** Request bodies shared with the HTTP client. */
export type { CommandBody } from '../api/client';
import type { CommandBody } from '../api/client';

/** Ein Schreibvorgang, der als Befehl verstanden wurde. */
export interface ParsedCommand {
	/** Fahrgestellnummer aus der Zustands-ID. */
	vin: string;
	/** Domaene samt Antwortblock und Ist-Werten. */
	def: CommandDomainDef;
	/** `start`, `stop` or the numeric `limit` setting. */
	action: CommandAction;
	/** Der Zustand, den der Nutzer haben will. */
	desired: boolean | number;
	/** True, wenn der Befehl ueber den Soll-Schalter kam und nicht ueber einen Knopf. */
	viaSwitch: boolean;
	/** Pfad des ausloesenden Zustands unterhalb des Geraeteknotens. */
	statePath: string;
	/** Der Befehl in Kurzform, z.B. `charging.start`. */
	name: string;
}

/**
 * Deutet eine Zustands-ID als Befehl.
 *
 * @param relativeId ID ohne Namensraum, z.B. `TMBJB9NY5RF999999.charging.enabled`.
 * @param value Der geschriebene Wert.
 * @returns Der Befehl, oder undefined wenn die ID keiner ist.
 */
export function parseCommandState(relativeId: string, value: unknown): ParsedCommand | undefined {
	const parts = relativeId.split('.');
	const [vin, ...path] = parts;
	if (path.join('.') === CHARGING_LIMIT_PATH) {
		return {
			vin,
			def: CHARGING_LIMIT_DEF,
			action: 'limit',
			desired: typeof value === 'number' ? value : NaN,
			viaSwitch: true,
			statePath: CHARGING_LIMIT_PATH,
			name: 'charging.limit',
		};
	}
	if (parts.length !== 3) {
		return undefined;
	}
	const [, block, leaf] = parts;
	const def = commandDefForPart(block);
	if (!def) {
		return undefined;
	}

	if (leaf === 'enabled') {
		const desired = value === true;
		return {
			vin,
			def,
			action: desired ? 'start' : 'stop',
			desired,
			viaSwitch: true,
			statePath: `${block}.enabled`,
			name: `${block}.${desired ? 'start' : 'stop'}`,
		};
	}

	if (leaf === 'start' || leaf === 'stop') {
		// Ein Knopf loest nur aus, wenn er gedrueckt wird. Ein `false` darauf ist
		// entweder die Quittung des Adapters oder ein Versehen.
		if (value !== true) {
			return undefined;
		}
		return {
			vin,
			def,
			action: leaf,
			desired: leaf === 'start',
			viaSwitch: false,
			statePath: `${block}.${leaf}`,
			name: `${block}.${leaf}`,
		};
	}

	return undefined;
}

/** Woraus der Koerper eines Befehls gebaut wird. */
export interface CommandBodyContext {
	/** Der zuletzt gepollte Block der Domaene, z.B. `airConditioning`. */
	block?: Record<string, unknown>;
	/**
	 * S-PIN aus der Instanzkonfiguration.
	 *
	 * **Niemals aus einem State** (E6/E14): Ein State ist lesbar, exportierbar und
	 * landet in jedem Backup des Objektbaums.
	 */
	spin?: string;
}

/** Ergebnis des Koerperbaus. `problem` heisst: Der Befehl kann so nicht gesendet werden. */
export interface CommandBodyResult {
	/** Der Koerper, oder undefined wenn der Endpunkt keinen nimmt. */
	body?: CommandBody;
	/** Warum der Befehl so nicht gesendet werden kann. */
	problem?: string;
}

/**
 * Baut den Koerper eines Befehls aus den zuletzt gepollten Daten.
 *
 * `charging/limit`, `air-conditioning/start` und `auxiliary-heating/start`
 * benoetigen einen Request-Koerper.
 *
 * @param command Der Befehl.
 * @param context Gepufferter Block und S-PIN.
 * @returns Der Koerper, oder die Beanstandung.
 */
export function buildCommandBody(command: ParsedCommand, context: CommandBodyContext): CommandBodyResult {
	if (command.action === 'limit') {
		const value = command.desired;
		if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > 100) {
			return { problem: 'Charging limit must be an integer between 1 and 100 percent.' };
		}
		return { body: { targetStateOfChargeInPercent: value } };
	}
	if (command.action !== 'start') {
		return {};
	}

	if (command.def.domain === 'air-conditioning') {
		const body: StartAirConditioningConfiguration = {};
		const target = readTargetTemperature(context.block);
		if (target) {
			body.targetTemperature = target;
		}
		const withoutPower = context.block?.airConditioningWithoutExternalPower;
		if (typeof withoutPower === 'boolean') {
			body.airConditioningWithoutExternalPower = withoutPower;
		}
		// Ein leerer Koerper ist zulaessig: Dann klimatisiert das Fahrzeug nach seinen
		// eigenen Einstellungen.
		return { body };
	}

	if (command.def.domain === 'auxiliary-heating') {
		if (!context.spin) {
			return {
				problem: 'Auxiliary heating requires an S-PIN, but none is set in the instance configuration.',
			};
		}
		const body: StartAuxiliaryHeatingConfiguration = { spin: context.spin };
		const target = readTargetTemperature(context.block);
		if (target) {
			body.targetTemperature = target;
		}
		return { body };
	}

	return {};
}

/**
 * Liest die Zieltemperatur aus einem gepufferten Block.
 *
 * @param block Der Block, z.B. `airConditioning`.
 * @returns Die Zieltemperatur, oder undefined wenn sie nicht vollstaendig dasteht.
 */
function readTargetTemperature(block?: Record<string, unknown>): { value: number; unit: string } | undefined {
	const target = block?.targetTemperature as Record<string, unknown> | undefined;
	if (typeof target?.value !== 'number' || typeof target.unit !== 'string') {
		return undefined;
	}
	return { value: target.value, unit: target.unit };
}
