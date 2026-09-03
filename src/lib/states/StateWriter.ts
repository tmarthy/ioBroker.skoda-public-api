/**
 * StateWriter - traegt die Antwort der API in den ioBroker-Objektbaum ein.
 *
 * Der Baum spiegelt das JSON der Antwort 1:1 (E7): Wurzel ist die VIN, darunter genau
 * die Struktur, die die API liefert. Das ist kein Selbstzweck. Bei einer API der
 * Version `v0` erscheinen neue Felder von selbst, und ein umbenanntes Feld faellt beim
 * naechsten `npm run codegen` als Compile-Fehler auf - statt als Zustand, der still
 * aufhoert sich zu aktualisieren.
 *
 * Drei Regeln, die sich aus den Entscheidungen ergeben:
 *
 * 1. **Objekte entstehen nur fuer Pfade, die tatsaechlich in der Antwort stehen**
 *    (E13). Ohne `include` liefert die API genau die Teile, die das Fahrzeug kann -
 *    das ist die eingebaute Faehigkeitserkennung. Angelegt wird einmal pro Pfad,
 *    danach nur noch geschrieben. **Geloescht wird nie.**
 * 2. **Fehlende Teile werden nicht auf `null` gesetzt** (E8), sondern behalten ihren
 *    letzten Wert und bekommen ein Quality-Flag. Sonst flackert die VIS bei jeder
 *    unvollstaendigen Antwort - und die sind laut Doku Normalbetrieb.
 * 3. **Die Befehls-States entstehen aus derselben Faehigkeitserkennung** wie die
 *    Lese-States (E15): Kein `auxiliaryHeating` in der Antwort, kein Schalter dafuer.
 */
import { vehicleErrors } from '../api/client';
import { newestCapturedAt } from '../api/vehicleData';
import { partFromErrorType } from '../api/parts';
import type { VehicleResponse } from '../api/types';
import { COMMAND_DEFS } from './commandDefs';
import { generatedChannels, generatedStateDefs } from './objectDefs.generated';
import { resolveCommon } from './objectOverlay';

/**
 * Quality-Flag "general problem".
 *
 * Damit ist ein Wert als nicht mehr verlaesslich markiert, ohne ihn zu verlieren -
 * VIS und Skripte koennen ihn weiter anzeigen und sehen zugleich, dass er steht.
 */
export const QUALITY_NOT_GOOD = 0x01;

/** Quality-Flag "good". */
export const QUALITY_GOOD = 0x00;

/**
 * Der Ausschnitt der Adapter-Schnittstelle, den der Writer braucht.
 *
 * Bewusst so schmal: Der Writer kennt keine Adapter-Instanz, die Tests brauchen keine,
 * und ein Test haelt fest, dass eine echte `ioBroker.Adapter` die Schnittstelle
 * erfuellt.
 */
export interface StateApi {
	/** Legt ein Objekt an, sofern es noch keines gibt. Aendert ein bestehendes nicht. */
	setObjectNotExistsAsync(id: string, obj: ioBroker.SettableObject): ioBroker.SetObjectPromise;
	/** Schreibt unbedingt - fuer das Quality-Flag, das `setStateChanged` nicht anfasst. */
	setStateAsync(id: string, state: ioBroker.SettableState): ioBroker.SetStatePromise;
	/** Schreibt nur bei einer Aenderung (E13). */
	setStateChangedAsync(id: string, state: ioBroker.SettableState): ioBroker.SetStateChangedPromise;
	/** Liest den aktuellen Wert - noetig, um die Qualitaet ohne Wertverlust zu senken. */
	getStateAsync(id: string): ioBroker.GetStatePromise;
	/** Der Adapter-Logger, auf zwei Stufen beschraenkt. */
	log: {
		debug(message: string): void;
		warn(message: string): void;
	};
}

/** Womit der Writer eingerichtet wird. */
export interface StateWriterOptions {
	/** Der Ausschnitt der Adapter-Schnittstelle, in den geschrieben wird. */
	api: StateApi;
	/** Zeitquelle fuer `info.dataAge`, ersetzbar fuer Tests. */
	now?: () => number;
}

/** Einheiten der Zieltemperatur. Die Skala steht im Geschwisterfeld `unit`. */
const TEMPERATURE_UNITS: Readonly<Record<string, string>> = {
	CELSIUS: '°C',
	FAHRENHEIT: '°F',
};

/** Die Liste der Ladeprofile bekommt eine eigene Behandlung (E16). */
const PROFILES_PATH = 'chargingProfiles.profiles';

/**
 * Traegt Fahrzeugantworten in den Objektbaum ein und haelt fest, was er dort schon
 * angelegt hat.
 */
export class StateWriter {
	private readonly api: StateApi;
	private readonly now: () => number;

	/** Bereits angelegte Objekte - Anlage genau einmal pro Pfad (E13). */
	private readonly createdObjects = new Set<string>();
	/** Davon die Zustaende, fuer die Markierung fehlender Teile. */
	private readonly createdStates = new Set<string>();
	/** Zustaende, die gerade als "nicht gut" markiert sind. */
	private readonly staleStates = new Set<string>();
	/** Bereits gemeldete unbekannte Pfade - eine Warnung je Pfad genuegt. */
	private readonly warnedPaths = new Set<string>();

	/**
	 * @param options Adapter-Schnittstelle und Zeitquelle.
	 */
	public constructor(options: StateWriterOptions) {
		this.api = options.api;
		this.now = options.now ?? (() => Date.now());
	}

	/**
	 * Traegt eine Fahrzeugantwort in den Objektbaum ein.
	 *
	 * @param vin Fahrgestellnummer; sie ist der Geraeteknoten.
	 * @param response Die Antwort, wie der Client sie geliefert hat.
	 */
	public async write(vin: string, response: VehicleResponse): Promise<void> {
		const vehicle = response.vehicle as Record<string, unknown>;
		await this.ensureDevice(vin, vehicle);

		for (const [key, value] of Object.entries(vehicle)) {
			await this.writeNode(vin, key, value);
		}

		await this.writeParkingPositionShortcut(vin, vehicle);
		await this.writeCommandStates(vin, vehicle);
		await this.writeInfo(vin, vehicle, response);
		await this.markMissingParts(vin, response);
	}

	/**
	 * Legt den Geraeteknoten an.
	 *
	 * Der Name kommt aus dem Fahrzeugnamen, ersatzweise dem Kennzeichen. Er wird nur
	 * bei der Anlage gesetzt: Wer das Fahrzeug spaeter in der App umbenennt, hat den
	 * Namen im ioBroker-Objekt bereits von Hand in der Hand.
	 *
	 * @param vin Fahrgestellnummer.
	 * @param vehicle Die Fahrzeugdaten der Antwort.
	 */
	private async ensureDevice(vin: string, vehicle: Record<string, unknown>): Promise<void> {
		if (this.createdObjects.has(vin)) {
			return;
		}
		const name = [vehicle.name, vehicle.licensePlate].find(v => typeof v === 'string' && v.length > 0);
		await this.api.setObjectNotExistsAsync(vin, {
			type: 'device',
			common: { name: (name as string | undefined) ?? vin },
			native: {},
		});
		this.createdObjects.add(vin);
	}

	/**
	 * Schreibt einen Knoten des Antwortbaums, je nach Art als Kanal, Liste oder Wert.
	 *
	 * @param vin Fahrgestellnummer.
	 * @param path Punktpfad unterhalb des Geraeteknotens.
	 * @param value Der Wert aus der Antwort.
	 */
	private async writeNode(vin: string, path: string, value: unknown): Promise<void> {
		if (value === null || value === undefined) {
			return;
		}
		if (Array.isArray(value)) {
			await this.writeArrayNode(vin, path, value);
			return;
		}
		if (typeof value === 'object') {
			await this.writeObjectNode(vin, path, value as Record<string, unknown>);
			return;
		}
		await this.writeLeaf(vin, path, value as ioBroker.StateValue);
	}

	/**
	 * Legt einen Kanal an und steigt in seine Felder ab.
	 *
	 * @param vin Fahrgestellnummer.
	 * @param path Punktpfad des Kanals.
	 * @param node Der Teilbaum.
	 */
	private async writeObjectNode(vin: string, path: string, node: Record<string, unknown>): Promise<void> {
		await this.ensureChannel(vin, path, generatedChannels[path]);

		// Die Zieltemperatur traegt ihre Skala im Geschwisterfeld `unit`. Aus der Spec
		// laesst sich die Einheit deshalb nicht ableiten, aus den Daten schon.
		const unit =
			typeof node.unit === 'string' && node.value !== undefined ? TEMPERATURE_UNITS[node.unit] : undefined;

		for (const [key, value] of Object.entries(node)) {
			const childPath = `${path}.${key}`;
			if (key === 'value' && unit) {
				await this.writeLeaf(vin, childPath, value as ioBroker.StateValue, { unit });
				continue;
			}
			await this.writeNode(vin, childPath, value);
		}
	}

	/**
	 * Schreibt eine Liste.
	 *
	 * Die Ladeprofile bekommen eigene Knoten je Profil-ID (E16), alle anderen Listen
	 * landen als JSON-Zeichenkette in einem Zustand: Sie sind read-only und aendern
	 * sich alle paar Monate - ein Objektbaum brachte dort nichts ausser Objekten, die
	 * nie jemand aufraeumt.
	 *
	 * @param vin Fahrgestellnummer.
	 * @param path Punktpfad der Liste.
	 * @param value Die Liste.
	 */
	private async writeArrayNode(vin: string, path: string, value: unknown[]): Promise<void> {
		if (path === PROFILES_PATH) {
			await this.writeChargingProfiles(vin, value);
			return;
		}
		await this.writeLeaf(vin, path, JSON.stringify(value));
	}

	/**
	 * Legt je Ladeprofil einen Knoten unter seiner ID an.
	 *
	 * ID-basiert und nicht ueber den Index: Wer in der App ein Profil loescht,
	 * verschiebt sonst alle folgenden - `profiles.0` zeigte danach still auf ein
	 * anderes Profil (E16).
	 *
	 * @param vin Fahrgestellnummer.
	 * @param profiles Die Profile aus der Antwort.
	 */
	private async writeChargingProfiles(vin: string, profiles: unknown[]): Promise<void> {
		await this.ensureChannel(vin, PROFILES_PATH, 'Charging profiles by id');

		for (const entry of profiles) {
			if (typeof entry !== 'object' || entry === null) {
				continue;
			}
			const profile = entry as Record<string, unknown>;
			const id = profile.id;
			if (typeof id !== 'number' && typeof id !== 'string') {
				continue;
			}
			const base = `${PROFILES_PATH}.${id}`;
			const settings = (profile.settings ?? {}) as Record<string, unknown>;
			await this.ensureChannel(vin, base, typeof profile.name === 'string' ? profile.name : `Profile ${id}`);

			// Die Profilebene steht nicht im Generat - die Spec kennt dort eine Liste,
			// keine benannten Pfade. Das `common` entsteht deshalb aus einer
			// synthetischen Definition; die Endungsregeln des Overlays greifen wie
			// ueberall sonst, `targetStateOfChargeInPercent` bekommt also Prozent.
			if (profile.name !== undefined) {
				await this.writeDerived(
					vin,
					`${base}.name`,
					profile.name as ioBroker.StateValue,
					resolveCommon(`${base}.name`, { type: 'string', desc: 'Name of the charging profile' }),
				);
			}
			if (settings.targetStateOfChargeInPercent !== undefined) {
				const path = `${base}.targetStateOfChargeInPercent`;
				await this.writeDerived(
					vin,
					path,
					settings.targetStateOfChargeInPercent as ioBroker.StateValue,
					resolveCommon(path, { type: 'number', desc: 'Target charging level of this profile' }),
				);
			}
			// Alles unterhalb der Profilebene als JSON - so geht nichts verloren, ohne
			// dass dutzende Objekte entstehen, die niemand pflegt.
			await this.writeJsonLeaf(vin, `${base}.settingsJson`, profile.settings, 'Charging profile settings');
			await this.writeJsonLeaf(vin, `${base}.timersJson`, profile.timers, 'Charging timers');
			await this.writeJsonLeaf(
				vin,
				`${base}.preferredChargingTimesJson`,
				profile.preferredChargingTimes,
				'Preferred charging times',
			);
		}
	}

	/**
	 * Schreibt einen Wert als JSON-Zustand, sofern er vorhanden ist.
	 *
	 * @param vin Fahrgestellnummer.
	 * @param path Punktpfad des Zustands.
	 * @param value Der Wert; undefined legt nichts an.
	 * @param name Anzeigename des Zustands.
	 */
	private async writeJsonLeaf(vin: string, path: string, value: unknown, name: string): Promise<void> {
		if (value === undefined) {
			return;
		}
		await this.writeDerived(vin, path, JSON.stringify(value), {
			name,
			type: 'string',
			role: 'json',
			read: true,
			write: false,
		});
	}

	/**
	 * Legt einen Zustand an, den der Adapter selbst bildet, und schreibt seinen Wert.
	 *
	 * Fuer `info.*`, die Position als `lat;lon` und die Profilebene: Diese Pfade stehen
	 * nicht im Generat und sollen deshalb auch keine Warnung ueber eine geaenderte Spec
	 * ausloesen - ihr `common` steht hier im Code.
	 *
	 * @param vin Fahrgestellnummer.
	 * @param path Punktpfad des Zustands.
	 * @param value Der Wert.
	 * @param common Das vollstaendige `common`.
	 */
	private async writeDerived(
		vin: string,
		path: string,
		value: ioBroker.StateValue,
		common: ioBroker.StateCommon,
	): Promise<void> {
		const id = `${vin}.${path}`;
		if (!this.createdObjects.has(id)) {
			await this.api.setObjectNotExistsAsync(id, { type: 'state', common, native: {} });
			this.createdObjects.add(id);
			this.createdStates.add(id);
		}
		await this.writeValue(id, value);
	}

	/**
	 * Legt den Zustand an, falls noetig, und schreibt seinen Wert.
	 *
	 * @param vin Fahrgestellnummer.
	 * @param path Punktpfad des Zustands.
	 * @param value Der Wert.
	 * @param overrides Ergaenzungen zum `common`, die sich erst aus den Daten ergeben.
	 */
	private async writeLeaf(
		vin: string,
		path: string,
		value: ioBroker.StateValue,
		overrides: Partial<ioBroker.StateCommon> = {},
	): Promise<void> {
		const id = `${vin}.${path}`;
		if (!this.createdObjects.has(id)) {
			await this.api.setObjectNotExistsAsync(id, {
				type: 'state',
				common: { ...this.commonFor(path, value), ...overrides },
				native: {},
			});
			this.createdObjects.add(id);
			this.createdStates.add(id);
		}
		await this.writeValue(id, value);
	}

	/**
	 * Baut das `common` eines Zustands.
	 *
	 * Steht der Pfad nicht im Generat, hat Skoda die Spec vermutlich erweitert. Dann
	 * wird der Zustand trotzdem angelegt - mit geratenem Typ und einer Warnung, denn
	 * ein stiller Datenverlust waere schlimmer als ein ungenaues `common`.
	 *
	 * @param path Punktpfad des Zustands.
	 * @param value Der Wert, aus dem der Typ notfalls geraten wird.
	 * @returns Das `common` fuer `setObjectNotExists`.
	 */
	private commonFor(path: string, value: ioBroker.StateValue): ioBroker.StateCommon {
		const def = generatedStateDefs[path];
		if (def) {
			return resolveCommon(path, def);
		}
		if (!this.warnedPaths.has(path)) {
			this.warnedPaths.add(path);
			// Ohne VIN: Die Meldung landet im Log und das Log im Forum (E14).
			this.api.log.warn(
				`Unbekannter Pfad "${path}" in der Antwort - vermutlich hat Skoda die Spec erweitert. ` +
					'Der Zustand wird mit geratenem Typ angelegt; "npm run codegen" holt ihn nach.',
			);
		}
		const type = typeof value === 'number' ? 'number' : typeof value === 'boolean' ? 'boolean' : 'string';
		return { name: path, type, role: 'state', read: true, write: false };
	}

	/**
	 * Legt einen Kanal an.
	 *
	 * @param vin Fahrgestellnummer.
	 * @param path Punktpfad des Kanals.
	 * @param name Anzeigename, ersatzweise der Pfad.
	 */
	private async ensureChannel(vin: string, path: string, name?: string): Promise<void> {
		const id = `${vin}.${path}`;
		if (this.createdObjects.has(id)) {
			return;
		}
		await this.api.setObjectNotExistsAsync(id, {
			type: 'channel',
			common: { name: name ?? path },
			native: {},
		});
		this.createdObjects.add(id);
	}

	/**
	 * Schreibt einen Wert und hebt dabei eine bestehende Markierung auf.
	 *
	 * `setStateChanged` allein genuegt nicht: Kommt ein Teil mit unveraendertem Wert
	 * zurueck, wuerde gar nicht geschrieben - und das Quality-Flag bliebe stehen,
	 * obwohl der Wert wieder frisch ist.
	 *
	 * @param id Vollstaendige Zustands-ID.
	 * @param val Der Wert.
	 */
	private async writeValue(id: string, val: ioBroker.StateValue): Promise<void> {
		if (this.staleStates.has(id)) {
			await this.api.setStateAsync(id, { val, ack: true, q: QUALITY_GOOD });
			this.staleStates.delete(id);
			return;
		}
		await this.api.setStateChangedAsync(id, { val, ack: true });
	}

	/**
	 * Zusaetzlicher Zustand `parkingPosition.position` im Format `lat;lon`.
	 *
	 * Die einzige Ausnahme vom 1:1-Prinzip (E7): VIS-Karten und Geofence-Adapter
	 * erwarten beide Koordinaten in einem Zustand.
	 *
	 * @param vin Fahrgestellnummer.
	 * @param vehicle Die Fahrzeugdaten.
	 */
	private async writeParkingPositionShortcut(vin: string, vehicle: Record<string, unknown>): Promise<void> {
		const parking = vehicle.parkingPosition as Record<string, unknown> | undefined;
		const coordinates = parking?.gpsCoordinates as Record<string, unknown> | undefined;
		if (typeof coordinates?.latitude !== 'number' || typeof coordinates.longitude !== 'number') {
			return;
		}
		await this.writeDerived(vin, 'parkingPosition.position', `${coordinates.latitude};${coordinates.longitude}`, {
			name: 'Parking position as lat;lon',
			type: 'string',
			role: 'value.gps',
			read: true,
			write: false,
		});
	}

	/**
	 * Legt die Befehls-States der Domaenen an, die das Fahrzeug tatsaechlich liefert.
	 *
	 * Der Schalter traegt den Soll-Zustand, die beiden Knoepfe erzwingen einen Aufruf
	 * (E6). Geschrieben wird hier nur der Ist-Zustand des Schalters mit `ack: true`;
	 * was ein Nutzer hineinschreibt, wertet die CommandQueue in Phase 7 aus.
	 *
	 * @param vin Fahrgestellnummer.
	 * @param vehicle Die Fahrzeugdaten.
	 */
	private async writeCommandStates(vin: string, vehicle: Record<string, unknown>): Promise<void> {
		for (const def of COMMAND_DEFS) {
			const block = vehicle[def.part];
			if (typeof block !== 'object' || block === null) {
				continue;
			}

			const enabledId = `${vin}.${def.part}.enabled`;
			if (!this.createdObjects.has(enabledId)) {
				await this.api.setObjectNotExistsAsync(enabledId, {
					type: 'state',
					common: {
						name: def.label,
						type: 'boolean',
						role: 'switch',
						read: true,
						write: true,
					},
					native: {},
				});
				this.createdObjects.add(enabledId);
				this.createdStates.add(enabledId);

				for (const action of ['start', 'stop'] as const) {
					const buttonId = `${vin}.${def.part}.${action}`;
					await this.api.setObjectNotExistsAsync(buttonId, {
						type: 'state',
						common: {
							name: `${def.label} - ${action}`,
							type: 'boolean',
							role: 'button',
							read: false,
							write: true,
						},
						native: {},
					});
					this.createdObjects.add(buttonId);
				}
			}

			const current = readPath(block as Record<string, unknown>, def.statePath);
			if (typeof current === 'string') {
				await this.writeValue(enabledId, def.activeStates.includes(current));
			}
		}
	}

	/**
	 * Schreibt die Zustaende unter `<vin>.info`.
	 *
	 * `dataAge` ist der Abstand zum juengsten `carCapturedTimestamp` der Antwort. Ohne
	 * ihn haelt man tagealte Werte fuer aktuelle - die Werte bleiben laut E8 ja
	 * absichtlich stehen. `lastErrors` wird auch dann geschrieben, wenn nichts fehlt:
	 * Sonst bliebe die Fehlerliste des letzten Ausfalls stehen.
	 *
	 * @param vin Fahrgestellnummer.
	 * @param vehicle Die Fahrzeugdaten.
	 * @param response Die vollstaendige Antwort.
	 */
	private async writeInfo(vin: string, vehicle: Record<string, unknown>, response: VehicleResponse): Promise<void> {
		await this.ensureChannel(vin, 'info', 'Adapter information');

		const captured = newestCapturedAt(vehicle);
		if (captured !== undefined) {
			await this.writeDerived(vin, 'info.dataAge', Math.max(0, Math.round((this.now() - captured) / 1000)), {
				name: 'Age of the newest vehicle data',
				type: 'number',
				role: 'value.interval',
				unit: 's',
				read: true,
				write: false,
			});
		}

		await this.writeDerived(vin, 'info.lastErrors', JSON.stringify(vehicleErrors(response)), {
			name: 'Errors reported with the last response',
			type: 'string',
			role: 'json',
			read: true,
			write: false,
		});
	}

	/**
	 * Markiert die Zustaende der Teile, die in dieser Antwort gefehlt haben.
	 *
	 * Der Wert bleibt stehen, nur die Qualitaet wird schlecht (E8). Betroffen sind
	 * ausschliesslich Teile, die die API selbst in `errors[]` gemeldet hat - ein Teil,
	 * das per `include` gar nicht angefordert wurde, fehlt nicht, es wurde nur nicht
	 * aufgefrischt. Wie alt die Daten sind, sagt `info.dataAge`.
	 *
	 * @param vin Fahrgestellnummer.
	 * @param response Die vollstaendige Antwort.
	 */
	private async markMissingParts(vin: string, response: VehicleResponse): Promise<void> {
		for (const error of vehicleErrors(response)) {
			const part = partFromErrorType(error.type);
			if (!part) {
				continue;
			}
			const prefix = `${vin}.${part}.`;
			for (const id of this.createdStates) {
				if (id.startsWith(prefix)) {
					await this.markStale(id);
				}
			}
		}
	}

	/**
	 * Setzt das Quality-Flag eines Zustands, ohne seinen Wert anzutasten.
	 *
	 * @param id Vollstaendige Zustands-ID.
	 */
	private async markStale(id: string): Promise<void> {
		if (this.staleStates.has(id)) {
			return;
		}
		const current = await this.api.getStateAsync(id);
		if (!current) {
			return;
		}
		this.staleStates.add(id);
		if ((current.q ?? QUALITY_GOOD) === QUALITY_NOT_GOOD) {
			return;
		}
		await this.api.setStateAsync(id, { val: current.val, ack: true, q: QUALITY_NOT_GOOD });
	}
}

/**
 * Liest einen Punktpfad aus einem Objekt.
 *
 * @param node Das Objekt.
 * @param path Punktpfad, z.B. `status.state`.
 * @returns Der Wert, oder undefined.
 */
function readPath(node: Record<string, unknown>, path: string): unknown {
	let current: unknown = node;
	for (const key of path.split('.')) {
		if (typeof current !== 'object' || current === null) {
			return undefined;
		}
		current = (current as Record<string, unknown>)[key];
	}
	return current;
}
