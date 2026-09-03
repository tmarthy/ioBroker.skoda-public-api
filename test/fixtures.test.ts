import { expect } from 'chai';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { generatedStateDefs } from '../src/lib/states/objectDefs.generated';
import { resolveCommon } from '../src/lib/states/objectOverlay';

/**
 * Haelt die echten Fahrzeugaufnahmen gegen das aus der Spec erzeugte Modell.
 *
 * Der Nutzen liegt in der Richtung: Die Aufnahmen sind Tatsachen, das Generat ist eine
 * Ableitung aus Skodas Dokumentation. Weicht beides voneinander ab, liegt der Fehler
 * fast immer im Generat - etwa wenn der Prosa-Parser einen Aufzaehlungswert uebersieht
 * oder Skoda ein Feld umbenennt. Ohne diesen Test faellt das erst auf, wenn im Betrieb
 * ein State fehlt oder einen Wert traegt, den die Admin-UI nicht anzeigen kann.
 */
const FIXTURE_DIR = path.join(__dirname, 'fixtures');

interface Fixture {
	description: string;
	body: { vehicle: Record<string, unknown>; errors?: unknown[] };
}

function loadFixtures(): Array<{ name: string; fixture: Fixture; real: boolean }> {
	return readdirSync(FIXTURE_DIR)
		.filter(f => f.startsWith('vehicle-') && f.endsWith('.json'))
		.map(f => {
			const name = f.replace(/^vehicle-|\.json$/g, '');
			return {
				name,
				fixture: JSON.parse(readFileSync(path.join(FIXTURE_DIR, f), 'utf8')) as Fixture,
				real: !name.startsWith('synth-'),
			};
		});
}

/**
 * Laeuft den JSON-Baum ab und meldet jeden Blattwert mit seinem Punktpfad.
 *
 * @param node Ein beliebiger JSON-Knoten.
 * @param prefix Der bereits aufgebaute Punktpfad.
 * @returns Paare aus Punktpfad und Blattwert.
 */
function leaves(node: unknown, prefix = ''): Array<[string, unknown]> {
	if (node === null || typeof node !== 'object' || Array.isArray(node)) {
		return [[prefix, node]];
	}
	return Object.entries(node).flatMap(([key, value]) => leaves(value, prefix ? `${prefix}.${key}` : key));
}

const fixtures = loadFixtures();

describe('Fixtures => Abgleich mit dem Generat', () => {
	it('findet ueberhaupt Aufnahmen', () => {
		expect(fixtures.length).to.be.greaterThan(0);
		expect(
			fixtures.some(f => f.real),
			'keine echte Aufnahme vorhanden',
		).to.equal(true);
	});

	for (const { name, fixture } of fixtures) {
		describe(`vehicle-${name}`, () => {
			// Listen unterhalb von chargingProfiles.profiles werden bewusst als JSON abgelegt
			// und haben deshalb keine Eintraege im Generat (E16).
			const relevant = leaves(fixture.body.vehicle).filter(([p]) => !p.startsWith('chargingProfiles.profiles.'));

			it('enthaelt nur Pfade, die das Generat kennt', () => {
				const unbekannt = relevant.filter(([p]) => !(p in generatedStateDefs)).map(([p]) => p);
				expect(unbekannt, `unbekannte Pfade: ${unbekannt.join(', ')}`).to.be.empty;
			});

			it('enthaelt nur Aufzaehlungswerte, die das Generat kennt', () => {
				const fremd = relevant
					.filter(([p, v]) => {
						const def = generatedStateDefs[p];
						return def?.states && typeof v === 'string' && !(v in def.states);
					})
					.map(([p, v]) => `${p} = ${String(v)}`);
				expect(fremd, `unbekannte Werte: ${fremd.join(', ')}`).to.be.empty;
			});

			it('stimmt in den Datentypen mit dem Generat ueberein', () => {
				const konflikte = relevant
					.filter(([p, v]) => {
						const def = generatedStateDefs[p];
						if (!def || v === null) {
							return false;
						}
						const ist = typeof v === 'number' ? 'number' : typeof v === 'boolean' ? 'boolean' : 'string';
						return ist !== def.type;
					})
					.map(([p, v]) => `${p}: ${typeof v} statt ${generatedStateDefs[p].type}`);
				expect(konflikte, konflikte.join(', ')).to.be.empty;
			});

			it('laesst sich vollstaendig in ioBroker-Objekte uebersetzen', () => {
				for (const [p] of relevant) {
					const common = resolveCommon(p, generatedStateDefs[p]);
					expect(common.role, p).to.be.a('string').and.not.empty;
				}
			});
		});
	}
});

describe('Fixtures => was die echten Aufnahmen ueber die API verraten', () => {
	const real = fixtures.filter(f => f.real);

	it('bestaetigt, dass errors bei fehlerfreier Antwort ganz fehlt', () => {
		// Skodas eigene Dokumentation zeigt im Beispiel "errors": []. Keine einzige echte
		// Antwort enthaelt den Schluessel. Deshalb immer body.errors ?? [] schreiben.
		for (const { name, fixture } of real) {
			expect(fixture.body, `${name} enthaelt errors`).to.not.have.property('errors');
		}
	});

	it('haelt fest, dass Zeitstempel in unterschiedlicher Genauigkeit kommen', () => {
		// Beobachtet: 0, 2, 3 und 9 Nachkommastellen - teils Nanosekunden. Ein
		// Zeichenketten-Vergleich zweier Zeitstempel ist deshalb unzuverlaessig;
		// zum Vergleichen immer nach Millisekunden parsen (relevant fuer den
		// Frische-Backoff in Phase 6).
		const stellen = new Set<number>();
		for (const { fixture } of real) {
			for (const m of JSON.stringify(fixture.body).matchAll(/"\d{4}-\d{2}-\d{2}T[\d:]+(\.\d+)?Z"/g)) {
				stellen.add(m[1] ? m[1].length - 1 : 0);
			}
		}
		expect(stellen.size, 'nur eine Genauigkeit beobachtet - Annahme pruefen').to.be.greaterThan(1);
		for (const s of stellen) {
			expect(Number.isNaN(Date.parse(`2026-09-03T17:51:16${s ? `.${'1'.repeat(s)}` : ''}Z`))).to.equal(false);
		}
	});
});
