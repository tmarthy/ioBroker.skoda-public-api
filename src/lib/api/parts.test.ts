import { expect } from 'chai';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { ERROR_REPORTING_PARTS, RENDER_UNAVAILABLE, partErrorType, partFromErrorType } from './parts';

/**
 * Die Fehlertypen stehen in der Spec nur in Prosa. Dieser Test haelt die
 * handgepflegte Zuordnung dagegen - so faellt eine Umbenennung durch Skoda beim
 * naechsten `npm run codegen` plus Testlauf auf und nicht erst im Betrieb.
 */
describe('api/parts => Zuordnung Antwortteil <-> Fehlertyp', () => {
	const specText = readFileSync(path.join(__dirname, '..', '..', '..', 'spec', 'skoda-openapi.json'), 'utf8');

	it('kennt jeden Fehlertyp, den die Spec beschreibt', () => {
		for (const part of ERROR_REPORTING_PARTS) {
			for (const kind of ['UNSUPPORTED', 'DISABLED', 'UNAVAILABLE'] as const) {
				const type = partErrorType(part, kind);
				expect(specText, `${type} steht nicht in der Spec`).to.contain(type);
			}
		}
		expect(specText).to.contain(RENDER_UNAVAILABLE);
	});

	it('bildet Fehlertypen zurueck auf ihren Antwortteil ab', () => {
		expect(partFromErrorType('CHARGING_UNAVAILABLE')).to.equal('charging');
		expect(partFromErrorType('VEHICLE_STATUS_DISABLED')).to.equal('status');
		expect(partFromErrorType('CHARGING_PROFILES_UNSUPPORTED')).to.equal('chargingProfiles');
		expect(partFromErrorType('OPERATIONS_UNAVAILABLE')).to.equal('operations');
	});

	it('meldet unbekannte Fehlertypen als unbekannt statt zu raten', () => {
		expect(partFromErrorType('SOMETHING_NEW_UNAVAILABLE')).to.equal(undefined);
		expect(partFromErrorType(RENDER_UNAVAILABLE)).to.equal(undefined);
	});

	it('verwechselt CHARGING nicht mit CHARGING_PROFILES', () => {
		expect(partFromErrorType('CHARGING_PROFILES_DISABLED')).to.equal('chargingProfiles');
		expect(partFromErrorType('CHARGING_DISABLED')).to.equal('charging');
	});
});
