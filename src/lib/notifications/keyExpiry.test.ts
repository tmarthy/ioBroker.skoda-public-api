import { expect } from 'chai';
import { FakeAdapter } from '../../../test/helpers/fakeAdapter';
import type { ApiMeta } from '../api/client';
import { httpApiError } from '../api/errors';
import { OBJECT_NAME_LANGUAGES } from '../i18n';
import { API_KEY_CHANNEL, KeyExpiryWatcher, type KeyExpiryLog } from './keyExpiry';

const DAY = 86_400_000;
const PROBLEM_BASE = 'https://public.api.connect.skoda-auto.cz/problems';

/** Ein Log, das nichts ausgibt, aber alles behaelt. */
class RecordingLog implements KeyExpiryLog {
	public readonly lines: Array<[string, string]> = [];

	public info(message: string): void {
		this.lines.push(['info', message]);
	}
	public warn(message: string): void {
		this.lines.push(['warn', message]);
	}
	public error(message: string): void {
		this.lines.push(['error', message]);
	}
}

describe('notifications/keyExpiry => der Schluessel laeuft ab', () => {
	let clock: number;
	let adapter: FakeAdapter;
	let log: RecordingLog;
	let notifications: Array<[string, string]>;
	let watcher: KeyExpiryWatcher;

	const now = (): number => clock;
	const levels = (): string[] => log.lines.map(([level]) => level);

	// Eine Antwort, deren Schluessel in so vielen Tagen ablaeuft.
	const inDays = (days: number): ApiMeta => ({
		apiKeyExpiresAt: new Date(clock + days * DAY),
		consumedQuota: true,
	});

	beforeEach(() => {
		clock = Date.parse('2026-09-04T09:00:00Z');
		adapter = new FakeAdapter();
		log = new RecordingLog();
		notifications = [];
		watcher = new KeyExpiryWatcher({
			states: adapter,
			log,
			notify: (category, message) => {
				notifications.push([category, message]);
			},
			now,
		});
	});

	describe('Zustaende', () => {
		it('schreibt Ablaufdatum und Resttage aus jeder Antwort', async () => {
			await watcher.observe(inDays(30));
			expect(adapter.val(`${API_KEY_CHANNEL}.expiresAt`)).to.equal(new Date(clock + 30 * DAY).toISOString());
			expect(adapter.val(`${API_KEY_CHANNEL}.daysRemaining`)).to.equal(30);
		});

		it('legt die Objekte mit brauchbaren Rollen an', async () => {
			await watcher.observe(inDays(30));
			expect(adapter.objects.get(API_KEY_CHANNEL)?.type).to.equal('channel');
			expect(adapter.objects.get(`${API_KEY_CHANNEL}.expiresAt`)?.common).to.include({
				type: 'string',
				role: 'date',
			});
			expect(adapter.objects.get(`${API_KEY_CHANNEL}.daysRemaining`)?.common).to.include({ unit: 'd' });
			const name = adapter.objects.get(API_KEY_CHANNEL)?.common?.name as ioBroker.Translated;
			expect(name).to.include({
				en: 'API key',
				de: 'API-Schlüssel',
			});
			expect(Object.keys(name).sort()).to.deep.equal([...OBJECT_NAME_LANGUAGES].sort());
		});

		it('legt gar nichts an, solange die API nichts ueber den Ablauf sagt', async () => {
			await watcher.observe({ consumedQuota: true });
			expect(adapter.objects.size).to.equal(0);
			expect(log.lines).to.have.length(0);
		});
	});

	describe('Eskalation in drei Stufen', () => {
		it('schweigt, solange der Schluessel weit von seinem Ablauf weg ist', async () => {
			await watcher.observe(inDays(30));
			expect(log.lines).to.have.length(0);
			expect(notifications).to.have.length(0);
		});

		it('meldet 14 Tage als Hinweis, ohne Notification', async () => {
			await watcher.observe(inDays(14));
			expect(levels()).to.deep.equal(['info']);
			expect(log.lines[0][1]).to.contain('14 days');
			expect(log.lines[0][1]).to.contain('MyŠkoda app');
			expect(notifications).to.have.length(0);
		});

		it('meldet 7 Tage als Warnung und schickt eine Notification', async () => {
			await watcher.observe(inDays(7));
			expect(levels()).to.deep.equal(['warn']);
			expect(notifications.map(([category]) => category)).to.deep.equal(['apiKeyExpiring']);
		});

		it('meldet 2 Tage als Fehler', async () => {
			await watcher.observe(inDays(2));
			expect(levels()).to.deep.equal(['error']);
			expect(notifications[0][0]).to.equal('apiKeyExpiring');
		});

		it('nimmt die dringlichste passende Stufe', async () => {
			// Ein Tag Restlaufzeit ist auch unter 14 und unter 7 - gemeldet wird die 2.
			await watcher.observe(inDays(1));
			expect(levels()).to.deep.equal(['error']);
			expect(log.lines[0][1]).to.contain('1 day ');
		});
	});

	describe('Hoechstens einmal am Tag', () => {
		it('wiederholt dieselbe Stufe am selben Tag nicht', async () => {
			await watcher.observe(inDays(7));
			await watcher.observe(inDays(7));
			await watcher.observe(inDays(7));
			expect(log.lines).to.have.length(1);
			expect(notifications).to.have.length(1);
		});

		it('meldet am naechsten Tag wieder', async () => {
			await watcher.observe(inDays(7));
			clock += DAY;
			await watcher.observe(inDays(6));
			expect(levels()).to.deep.equal(['warn', 'warn']);
		});

		it('meldet die naechste Stufe auch am selben Tag', async () => {
			await watcher.observe(inDays(7));
			await watcher.observe(inDays(2));
			expect(levels()).to.deep.equal(['warn', 'error']);
		});
	});

	describe('Abgelaufen', () => {
		it('meldet einen abgelaufenen Schluessel als Alarm', async () => {
			await watcher.observe(inDays(-1));
			expect(levels()).to.deep.equal(['error']);
			expect(notifications[0][0]).to.equal('apiKeyExpired');
			expect(notifications[0][1]).to.contain('once per hour');
		});

		it('glaubt der API mehr als der eigenen Rechnung', async () => {
			// 401 api-key-expired schlaegt jede Restlaufzeit - auch wenn der Header
			// noch etwas anderes behauptet.
			const error = httpApiError({
				status: 401,
				body: JSON.stringify({ type: `${PROBLEM_BASE}/api-key-expired`, title: 'Unauthorized' }),
			});
			await watcher.observe({ consumedQuota: false }, error);
			expect(levels()).to.deep.equal(['error']);
			expect(notifications[0][0]).to.equal('apiKeyExpired');
		});

		it('wiederholt den Alarm nicht bei jedem Poll', async () => {
			await watcher.observe(inDays(-1));
			await watcher.observe(inDays(-1));
			expect(log.lines).to.have.length(1);

			clock += DAY;
			await watcher.observe(inDays(-2));
			expect(log.lines).to.have.length(2);
		});

		it('laesst andere Fehler in Ruhe', async () => {
			const error = httpApiError({ status: 500, body: '' });
			await watcher.observe({ consumedQuota: true }, error);
			expect(log.lines).to.have.length(0);
		});
	});

	describe('Erneuerter Schluessel', () => {
		it('faengt nach einem neuen Schluessel wieder von vorne an', async () => {
			await watcher.observe(inDays(2));
			expect(levels()).to.deep.equal(['error']);

			// Der Nutzer hat einen neuen Schluessel eingetragen.
			await watcher.observe(inDays(90));
			expect(adapter.val(`${API_KEY_CHANNEL}.daysRemaining`)).to.equal(90);

			// Drei Monate spaeter, derselbe Tag im Kalender waere sonst gesperrt.
			await watcher.observe(inDays(14));
			expect(levels()).to.deep.equal(['error', 'info']);
		});
	});
});
