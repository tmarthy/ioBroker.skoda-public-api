/** Internal cancellation, never a vehicle/API failure. */
export class ShutdownError extends Error {
	/** Creates an internal shutdown signal. */
	public constructor() {
		super('Adapter is stopping');
	}
}

/** Instance-local admission gate and registry for asynchronous lifecycle work. */
export class Lifecycle {
	public stopping = false;
	private readonly tasks = new Set<Promise<unknown>>();

	/** Rejects continuations at their next side-effect boundary. */
	public check(): void {
		if (this.stopping) {
			throw new ShutdownError();
		}
	}

	/**
	 * Tracks an event or callback, consuming expected cancellation.
	 *
	 * @param work Event work.
	 * @param onError Handler for unexpected failures.
	 */
	public run(work: () => unknown, onError: (error: unknown) => void): void {
		if (this.stopping) {
			return;
		}
		const task = Promise.resolve()
			.then(() => {
				this.check();
				return work();
			})
			.catch(error => {
				if (!(error instanceof ShutdownError)) {
					onError(error);
				}
			});
		this.tasks.add(task);
		void task.then(
			() => this.tasks.delete(task),
			() => this.tasks.delete(task),
		);
	}

	/**
	 * Guards each port call, including calls after an await inside a writer.
	 *
	 * @param target Adapter port. Methods retain their original receiver.
	 */
	public guard<T extends object>(target: T): T {
		return new Proxy(target, {
			get: (object, key) => {
				const value: unknown = Reflect.get(object, key);
				if (typeof value !== 'function') {
					return value;
				}
				return (...args: unknown[]) => {
					this.check();
					return Reflect.apply(value, object, args);
				};
			},
		});
	}

	/** Waits for admitted events and callbacks to settle. */
	public async drain(): Promise<void> {
		while (this.tasks.size) {
			await Promise.allSettled([...this.tasks]);
		}
	}
}
