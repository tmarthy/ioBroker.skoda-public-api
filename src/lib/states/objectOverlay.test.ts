import { expect } from 'chai';
import { generatedStateDefs } from './objectDefs.generated';
import { exactOverlayPaths, resolveCommon } from './objectOverlay';

describe('objectOverlay => resolveCommon', () => {
	it('reicht Einheit, Grenzen und Rolle fuer Prozentwerte durch', () => {
		const common = resolveCommon(
			'charging.status.battery.stateOfChargeInPercent',
			generatedStateDefs['charging.status.battery.stateOfChargeInPercent'],
		);
		expect(common.type).to.equal('number');
		expect(common.role).to.equal('value.battery');
		expect(common.unit).to.equal('%');
		expect(common.min).to.equal(0);
		expect(common.max).to.equal(100);
	});

	it('erkennt Endungsregeln auch auf tief verschachtelten Pfaden', () => {
		const common = resolveCommon('odometer.mileageInKm', generatedStateDefs['odometer.mileageInKm']);
		expect(common.role).to.equal('value.distance');
		expect(common.unit).to.equal('km');
	});

	it('gibt Zeitstempel als Zeichenkette mit Rolle date aus', () => {
		const common = resolveCommon('status.carCapturedTimestamp', generatedStateDefs['status.carCapturedTimestamp']);
		expect(common.type).to.equal('string');
		expect(common.role).to.equal('date');
	});

	it('beschriftet bekannte Aufzaehlungswerte und laesst unbekannte roh', () => {
		const common = resolveCommon('charging.status.state', generatedStateDefs['charging.status.state']);
		expect(common.states).to.deep.include({ CHARGING: 'Charging' });
		// Skoda darf laut Spec jederzeit neue Werte nachschieben - die duerfen nicht verschwinden.
		const unlabelled = resolveCommon(
			'charging.status.chargeType',
			generatedStateDefs['charging.status.chargeType'],
		);
		expect(Object.keys(unlabelled.states as object)).to.include('AC');
		expect((unlabelled.states as Record<string, string>).AC).to.equal('AC');
	});

	it('markiert jeden gespiegelten Zustand als nur lesbar', () => {
		for (const [path, def] of Object.entries(generatedStateDefs)) {
			const common = resolveCommon(path, def);
			expect(common.read, path).to.equal(true);
			expect(common.write, path).to.equal(false);
		}
	});

	it('liefert fuer jeden erzeugten Pfad eine vollstaendige Definition', () => {
		for (const [path, def] of Object.entries(generatedStateDefs)) {
			const common = resolveCommon(path, def);
			expect(common.type, path).to.be.oneOf(['number', 'string', 'boolean']);
			expect(common.role, path).to.be.a('string').and.not.empty;
			expect(common.name, path).to.be.a('string').and.not.empty;
		}
	});
});

describe('objectOverlay => Konsistenz mit dem Generat', () => {
	/**
	 * Faengt Tippfehler im Overlay und Pfade, die aus der Spec verschwunden sind.
	 * Beides waere sonst stumm: Ein Overlay-Eintrag auf einen Pfad, den es nicht gibt,
	 * greift schlicht nie.
	 */
	it('verweist auf keinen Pfad, den die Spec nicht kennt', () => {
		const unknown = exactOverlayPaths.filter(p => !(p in generatedStateDefs));
		expect(unknown, `Overlay-Pfade ohne Entsprechung in der Spec: ${unknown.join(', ')}`).to.be.empty;
	});
});
