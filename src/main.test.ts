import { expect } from 'chai';
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { runInNewContext } from 'node:vm';
import { transpileModule, ModuleKind, ScriptTarget } from 'typescript';

/** Minimal adapter-core port, keeping the real lifecycle wiring under test. */
class AdapterDouble extends EventEmitter {
	public config = { backendLanguage: 'en' };
	public writes = 0;
	public errors: string[] = [];
	public log = {
		error: (s: string): void => {
			this.errors.push(s);
		},
		warn: (): void => undefined,
	};
	public readyWrite: Promise<void> = Promise.resolve();
	public setState(): Promise<void> {
		this.writes++;
		return this.readyWrite;
	}
}

type Instance = AdapterDouble & {
	scheduler?: { stop: () => void; shutdown: () => Promise<void> };
	queue?: { stop: () => void; shutdown: () => Promise<void> };
	quota?: { flush: () => Promise<void> };
};

/** Loads the real factory with an injected adapter base and no shared module-cache mutation. */
function factory(): () => Instance {
	const filename = join(__dirname, 'main.ts');
	const localRequire = createRequire(filename);
	const output = transpileModule(readFileSync(filename, 'utf8'), {
		compilerOptions: { module: ModuleKind.CommonJS, target: ScriptTarget.ES2022 },
	});
	const module = { exports: {} };
	runInNewContext(output.outputText, {
		module,
		exports: module.exports,
		__dirname,
		require: (id: string) => (id === '@iobroker/adapter-core' ? { Adapter: AdapterDouble } : localRequire(id)),
	});
	return module.exports as () => Instance;
}

describe('adapter factory lifecycle', () => {
	it('drains ready interrupted at an await and calls unload exactly once', async () => {
		const instance = factory()();
		let resume!: () => void;
		instance.readyWrite = new Promise<void>(resolve => {
			resume = resolve;
		});
		instance.emit('ready');
		await Promise.resolve();
		expect(instance.writes).to.equal(1);
		let callbacks = 0;
		const unloaded = new Promise<void>(resolve =>
			instance.emit('unload', () => {
				callbacks++;
				resolve();
			}),
		);
		resume();
		await unloaded;
		instance.emit('ready');
		instance.emit('stateChange', 'skoda-public-api.0.any.start', { val: true, ack: false });
		instance.emit('message', { command: 'testConnection', message: {} });
		await Promise.resolve();
		expect(instance.writes).to.equal(1);
		expect(callbacks).to.equal(1);
		expect(instance.errors).to.deep.equal([]);
	});

	it('continues cleanup after stop and persistence failures and isolates a fresh factory instance', async () => {
		const create = factory();
		const first = create();
		const second = create();
		let queueStopped = false;
		let flushed = false;
		first.scheduler = {
			stop: () => {
				throw new Error('stop failed');
			},
			shutdown: () => Promise.reject(new Error('drain failed')),
		};
		first.queue = {
			stop: () => {
				queueStopped = true;
			},
			shutdown: () => Promise.resolve(),
		};
		first.quota = {
			flush: () => {
				flushed = true;
				return Promise.reject(new Error('store failed'));
			},
		};
		let callbacks = 0;
		await new Promise<void>(resolve =>
			first.emit('unload', () => {
				callbacks++;
				resolve();
			}),
		);
		expect(callbacks).to.equal(1);
		expect(queueStopped && flushed).to.equal(true);
		expect(first.errors).to.have.length(3);
		second.emit('ready');
		await Promise.resolve();
		expect(second.writes).to.equal(1);
		await new Promise<void>(resolve => second.emit('unload', resolve));
	});
});
