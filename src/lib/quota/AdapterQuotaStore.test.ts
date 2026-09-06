import { expect } from 'chai';
import { FakeAdapter } from '../../../test/helpers/fakeAdapter';
import { OBJECT_NAME_LANGUAGES } from '../i18n';
import { AdapterQuotaStore, LEGACY_QUOTA_CHANNEL, quotaChannel } from './AdapterQuotaStore';
import { QuotaManager } from './QuotaManager';

describe('quota/AdapterQuotaStore => Budget ueberlebt den Neustart', () => {
	const VIN = 'TMBJB9NY5RF999999';
	const QUOTA_CHANNEL = quotaChannel(VIN);
	let adapter: FakeAdapter;
	let store: AdapterQuotaStore;
	let clock: number;
	const now = (): number => clock;

	beforeEach(() => {
		clock = Date.parse('2026-09-03T18:00:00Z');
		adapter = new FakeAdapter();
		store = new AdapterQuotaStore(adapter, VIN);
	});

	it('meldet beim ersten Start, dass noch nichts da ist', async () => {
		expect(await store.load()).to.equal(undefined);
	});

	it('legt Kanal und Zustaende an', async () => {
		await store.save({ limit: 20, remaining: 19, resetAt: clock + 3_600_000, lastRequestAt: clock });
		expect(adapter.objects.get(QUOTA_CHANNEL)?.type).to.equal('channel');
		expect(adapter.objects.get(`${QUOTA_CHANNEL}.remaining`)?.common).to.include({
			type: 'number',
			role: 'value',
		});
		expect(adapter.objects.get(`${QUOTA_CHANNEL}.resetAt`)?.common).to.include({ role: 'date' });
		const name = adapter.objects.get(`${QUOTA_CHANNEL}.remaining`)?.common?.name as ioBroker.Translated;
		expect(name).to.include({
			en: 'Requests left in the current window',
			de: 'Verbleibende Requests im aktuellen Zeitfenster',
		});
		expect(Object.keys(name).sort()).to.deep.equal([...OBJECT_NAME_LANGUAGES].sort());
	});

	it('schreibt und liest denselben Zustand', async () => {
		const state = { limit: 20, remaining: 7, resetAt: clock + 1_800_000, lastRequestAt: clock - 60_000 };
		await store.save(state);
		expect(await store.load()).to.deep.equal(state);
	});

	it('uebernimmt beim Upgrade den alten instanzweiten Stand konservativ', async () => {
		const state = { limit: 20, remaining: 5, resetAt: clock + 1_800_000, lastRequestAt: clock - 60_000 };
		for (const [field, value] of Object.entries(state)) {
			await adapter.setStateAsync(`${LEGACY_QUOTA_CHANNEL}.${field}`, { val: value, ack: true });
		}
		expect(await store.load()).to.deep.equal(state);
	});

	it('meldet einen halben Zustand als gar keinen', async () => {
		await store.save({ limit: 20, remaining: 7, resetAt: clock, lastRequestAt: clock });
		// Jemand hat einen Zustand von Hand geleert.
		await adapter.setStateAsync(`${QUOTA_CHANNEL}.resetAt`, { val: null, ack: true });
		expect(await store.load()).to.equal(undefined);
	});

	it('haelt den Reststand ueber einen Neustart hinweg', async () => {
		const first = new QuotaManager({ now, store });
		await first.start();
		const permit = first.tryAcquire('poll');
		expect(permit).to.not.have.property('reason');
		if ('reason' in permit) {
			throw new Error('Poll unerwartet abgelehnt');
		}
		first.recordResponse(
			{ rateLimit: { limit: 20, remaining: 4, resetInSeconds: 1800 }, consumedQuota: true },
			permit,
		);
		await first.flush();

		clock += 10 * 60_000;
		const second = new QuotaManager({ now, store });
		await second.start();

		const snapshot = second.snapshot();
		expect(snapshot.remaining).to.equal(4);
		expect(snapshot.limit).to.equal(20);
		// Vier uebrig heisst: Polls sind gesperrt, Befehle nicht.
		expect(second.tryAcquire('poll')).to.have.property('reason');
		expect(second.tryAcquire('command')).to.not.have.property('reason');
	});
});
