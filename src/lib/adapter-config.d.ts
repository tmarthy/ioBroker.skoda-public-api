// This file extends the AdapterConfig type from "@iobroker/types"

// Augment the globally declared type ioBroker.AdapterConfig
declare global {
	namespace ioBroker {
		interface AdapterConfig {
			/** Statischer Schluessel aus der MySkoda-App, verschluesselt abgelegt. */
			apiKey: string;
			/** Die zu ueberwachenden Fahrzeuge. Eine Fahrzeugliste bietet die API nicht. */
			vins: { vin: string; label?: string }[];
			/** S-PIN fuer die Standheizung, verschluesselt abgelegt. */
			spin: string;
			/** Grundkadenz in Minuten. */
			pollIntervalIdle: number;
			/** Kadenz waehrend Laden oder Klimatisierung, in Minuten. */
			pollIntervalActive: number;
			/** Deckel des Frische-Backoffs in Minuten. */
			pollBackoffMax: number;
			/** Requests, die den Befehlen vorbehalten bleiben. */
			commandReserve: number;
			/** Lebensdauer eines wartenden Befehls in Minuten. */
			commandTtl: number;
			/** Parkposition mitlesen. Aus heisst: gar nicht erst anfordern. */
			readParkingPosition: boolean;
		}
	}
}

// this is required so the above AdapterConfig is found by TypeScript / type checking
export {};
