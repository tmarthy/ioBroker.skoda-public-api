/**
 * Adapter-Doppel fuer die Tests des StateWriters und des Schedulers.
 *
 * Es bildet die eine Eigenschaft nach, auf die es ankommt: `setStateChangedAsync`
 * schreibt nur bei einer Aenderung. Sonst liesse sich "ein zweiter Durchlauf schreibt
 * keinen einzigen State" gar nicht pruefen.
 */
import type { StateApi } from '../../src/lib/states/StateWriter';

/** Aufzeichnung eines tatsaechlich geschriebenen Werts. */
export interface WrittenState {
	val: ioBroker.StateValue;
	ack: boolean;
	q: number;
}

/** Ein Adapter, der alles im Speicher haelt. */
export class FakeAdapter implements StateApi {
	public readonly objects = new Map<string, ioBroker.SettableObject>();
	public readonly states = new Map<string, WrittenState>();
	/** Jede tatsaechliche Schreiboperation, in der Reihenfolge ihres Auftretens. */
	public readonly writes: string[] = [];
	public readonly warnings: string[] = [];

	public readonly log = {
		debug: (): void => undefined,
		warn: (message: string): void => {
			this.warnings.push(message);
		},
	};

	public setObjectNotExistsAsync(id: string, obj: ioBroker.SettableObject): ioBroker.SetObjectPromise {
		if (!this.objects.has(id)) {
			this.objects.set(id, obj);
		}
		return Promise.resolve({ id });
	}

	public setStateAsync(id: string, state: ioBroker.SettableState): ioBroker.SetStatePromise {
		this.apply(id, state);
		return Promise.resolve(id);
	}

	public setStateChangedAsync(id: string, state: ioBroker.SettableState): ioBroker.SetStateChangedPromise {
		const current = this.states.get(id);
		const next = this.normalize(state);
		const notChanged = current !== undefined && current.val === next.val && current.ack === next.ack;
		if (!notChanged) {
			this.apply(id, state);
		}
		return Promise.resolve(id);
	}

	public getStateAsync(id: string): ioBroker.GetStatePromise {
		const found = this.states.get(id);
		return Promise.resolve(found ? ({ ...found } as unknown as ioBroker.State) : null);
	}

	/** Nur die Zustaende, ohne die Kanaele - das, was der Nutzer als Werte sieht. */
	public get stateIds(): string[] {
		return [...this.objects.entries()].filter(([, obj]) => obj.type === 'state').map(([id]) => id);
	}

	public val(id: string): ioBroker.StateValue | undefined {
		return this.states.get(id)?.val;
	}

	public quality(id: string): number | undefined {
		return this.states.get(id)?.q;
	}

	private normalize(state: ioBroker.SettableState): WrittenState {
		return { val: state.val ?? null, ack: state.ack ?? false, q: state.q ?? 0 };
	}

	private apply(id: string, state: ioBroker.SettableState): void {
		this.states.set(id, this.normalize(state));
		this.writes.push(id);
	}
}
