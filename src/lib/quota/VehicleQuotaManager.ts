/**
 * Verwaltet einen unabhaengigen Quota-Bucket je Fahrzeug.
 *
 * Die MySkoda Public API begrenzt Requests pro VIN. Deshalb duerfen Antworten eines
 * Fahrzeugs weder den Reststand noch das Reset-Fenster eines anderen Fahrzeugs
 * veraendern. Der vorhandene QuotaManager bleibt der einzelne, gut getestete Bucket;
 * diese Klasse ordnet Requests dem richtigen Bucket zu.
 */
import type { ApiMeta } from '../api/client';
import {
	QuotaManager,
	type AcquireResult,
	type QuotaManagerOptions,
	type QuotaSnapshot,
	type QuotaStore,
	type RequestPermit,
	type RequestPriority,
} from './QuotaManager';

/** Vertrag fuer Scheduler, CommandQueue und Verbindungstest. */
export interface VehicleQuota {
	/** Fragt den Bucket des Fahrzeugs nach einer Request-Buchung. */
	tryAcquire(vin: string, priority: RequestPriority): AcquireResult;
	/** Bucht einen bewusst nicht blockierten Request fuer das Fahrzeug. */
	trackRequest(vin: string): RequestPermit;
	/** Schliesst eine Buchung mit den Antwort-Metadaten ab. */
	recordResponse(vin: string, meta: ApiMeta, permit?: RequestPermit): void;
}

/** Optionen fuer alle fahrzeugbezogenen Buckets. */
export interface VehicleQuotaManagerOptions extends Omit<QuotaManagerOptions, 'store'> {
	/** Fahrzeuge, deren persistierter Stand beim Start geladen wird. */
	vins: readonly string[];
	/** Erzeugt die getrennte Persistenz eines Fahrzeugs. */
	storeForVin?: (vin: string) => QuotaStore;
}

/**
 * Bindet einen einzelnen Bucket an eine VIN; nuetzlich fuer Ein-Fahrzeug-Ports und Tests.
 *
 * @param vin Fahrzeug des Buckets.
 * @param bucket Der einzelne QuotaManager.
 */
export function quotaForVehicle(vin: string, bucket: QuotaManager): VehicleQuota {
	const assertVin = (requestedVin: string): void => {
		if (requestedVin !== vin) {
			throw new Error('Quota-Bucket fuer unbekanntes Fahrzeug angefordert');
		}
	};
	return {
		tryAcquire(requestedVin, priority) {
			assertVin(requestedVin);
			return bucket.tryAcquire(priority);
		},
		trackRequest(requestedVin) {
			assertVin(requestedVin);
			return bucket.trackRequest();
		},
		recordResponse(requestedVin, meta, permit) {
			assertVin(requestedVin);
			bucket.recordResponse(meta, permit);
		},
	};
}

/** Ein QuotaManager je VIN mit gemeinsamer Konfiguration. */
export class VehicleQuotaManager implements VehicleQuota {
	private readonly buckets = new Map<string, QuotaManager>();
	private readonly options: Omit<QuotaManagerOptions, 'store'>;
	private readonly storeForVin?: (vin: string) => QuotaStore;

	/** @param options Fahrzeuge, gemeinsame Grenzen und optionale Persistenzfabrik. */
	public constructor(options: VehicleQuotaManagerOptions) {
		const { vins, storeForVin, ...bucketOptions } = options;
		this.options = bucketOptions;
		this.storeForVin = storeForVin;
		for (const vin of vins) {
			this.bucketFor(vin);
		}
	}

	/** Laedt alle bereits konfigurierten Fahrzeug-Buckets. */
	public async start(): Promise<void> {
		await Promise.all([...this.buckets.values()].map(bucket => bucket.start()));
	}

	public tryAcquire(vin: string, priority: RequestPriority): AcquireResult {
		return this.bucketFor(vin).tryAcquire(priority);
	}

	public trackRequest(vin: string): RequestPermit {
		return this.bucketFor(vin).trackRequest();
	}

	public recordResponse(vin: string, meta: ApiMeta, permit?: RequestPermit): void {
		this.bucketFor(vin).recordResponse(meta, permit);
	}

	/**
	 * Momentaufnahme genau eines Fahrzeugs.
	 *
	 * @param vin Fahrzeug des Buckets.
	 */
	public snapshot(vin: string): QuotaSnapshot {
		return this.bucketFor(vin).snapshot();
	}

	/** Wartet beim Entladen auf alle getrennten Speicherlaeufe. */
	public async flush(): Promise<void> {
		await Promise.all([...this.buckets.values()].map(bucket => bucket.flush()));
	}

	/**
	 * Legt auch fuer einen neuen Verbindungstest-Wert bei Bedarf einen Bucket an.
	 *
	 * @param vin Fahrzeug des Buckets.
	 */
	private bucketFor(vin: string): QuotaManager {
		let bucket = this.buckets.get(vin);
		if (!bucket) {
			bucket = new QuotaManager({
				...this.options,
				store: this.storeForVin?.(vin),
			});
			this.buckets.set(vin, bucket);
		}
		return bucket;
	}
}
