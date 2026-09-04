import { expect } from 'chai';
import { buildCommandBody, parseCommandState } from './commandMap';

const VIN = 'TMBJB9NY5RF999999';

describe('commands/commandMap => Zustands-ID zu Befehl', () => {
	describe('Soll-Schalter', () => {
		it('macht aus true ein start und aus false ein stop', () => {
			const start = parseCommandState(`${VIN}.charging.enabled`, true);
			expect(start).to.include({ vin: VIN, action: 'start', desired: true, viaSwitch: true });
			expect(start?.name).to.equal('charging.start');

			const stop = parseCommandState(`${VIN}.charging.enabled`, false);
			expect(stop).to.include({ action: 'stop', desired: false });
			expect(stop?.name).to.equal('charging.stop');
		});

		it('kennt alle vier Domaenen samt Endpunktnamen', () => {
			expect(parseCommandState(`${VIN}.airConditioning.enabled`, true)?.def.domain).to.equal('air-conditioning');
			expect(parseCommandState(`${VIN}.auxiliaryHeating.enabled`, true)?.def.domain).to.equal(
				'auxiliary-heating',
			);
			expect(parseCommandState(`${VIN}.activeVentilation.enabled`, true)?.def.domain).to.equal(
				'active-ventilation',
			);
		});
	});

	describe('Knoepfe', () => {
		it('erzwingt den Aufruf unabhaengig vom Ist-Zustand', () => {
			const parsed = parseCommandState(`${VIN}.charging.start`, true);
			expect(parsed).to.include({ action: 'start', viaSwitch: false });
			expect(parsed?.statePath).to.equal('charging.start');
		});

		it('loest nur beim Druecken aus, nicht bei der Quittung', () => {
			// Der Adapter setzt den Knopf nach dem Absetzen selbst auf false zurueck.
			expect(parseCommandState(`${VIN}.charging.start`, false)).to.equal(undefined);
		});
	});

	describe('Was kein Befehl ist', () => {
		it('ignoriert fremde Zustaende', () => {
			expect(parseCommandState(`${VIN}.charging.status.state`, 'CHARGING')).to.equal(undefined);
			expect(parseCommandState(`${VIN}.odometer.enabled`, true)).to.equal(undefined);
			expect(parseCommandState(`${VIN}.charging.irgendwas`, true)).to.equal(undefined);
			expect(parseCommandState('info.connection', true)).to.equal(undefined);
		});
	});

	describe('Koerper des Requests', () => {
		it('gibt fuer Laden und alle stop-Befehle keinen mit', () => {
			expect(buildCommandBody(parseCommandState(`${VIN}.charging.enabled`, true)!, {}).body).to.equal(undefined);
			expect(buildCommandBody(parseCommandState(`${VIN}.airConditioning.enabled`, false)!, {}).body).to.equal(
				undefined,
			);
		});

		it('baut die Klimatisierung aus den gepufferten Daten', () => {
			const command = parseCommandState(`${VIN}.airConditioning.enabled`, true)!;
			const { body } = buildCommandBody(command, {
				block: {
					targetTemperature: { value: 21.5, unit: 'CELSIUS' },
					airConditioningWithoutExternalPower: true,
				},
			});
			expect(body).to.deep.equal({
				targetTemperature: { value: 21.5, unit: 'CELSIUS' },
				airConditioningWithoutExternalPower: true,
			});
		});

		it('kommt ohne gepufferte Daten aus - dann entscheidet das Fahrzeug', () => {
			const command = parseCommandState(`${VIN}.airConditioning.enabled`, true)!;
			expect(buildCommandBody(command, {}).body).to.deep.equal({});
		});

		it('verlangt fuer die Standheizung den S-PIN aus der Konfiguration', () => {
			const command = parseCommandState(`${VIN}.auxiliaryHeating.enabled`, true)!;
			expect(buildCommandBody(command, {}).problem).to.contain('S-PIN');
			expect(buildCommandBody(command, { spin: '1234' }).body).to.deep.equal({ spin: '1234' });
		});

		it('nimmt den S-PIN niemals aus einem Zustand', () => {
			// Selbst wenn im gepufferten Block etwas namens spin staende: Ein State ist
			// lesbar, exportierbar und steht in jedem Backup (E6/E14).
			const command = parseCommandState(`${VIN}.auxiliaryHeating.enabled`, true)!;
			const { body, problem } = buildCommandBody(command, { block: { spin: '9999' } });
			expect(body).to.equal(undefined);
			expect(problem).to.contain('S-PIN');
		});
	});
});
