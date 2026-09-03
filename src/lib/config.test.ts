import { expect } from 'chai';
import { readConfig } from './config';

const VIN = 'TMBJB9NY5RF999999';

describe('config => Instanzkonfiguration pruefen', () => {
	const vollstaendig = { apiKey: 'sk-live-4f2a9c7e1b8d', vins: [{ vin: VIN }] };

	it('nimmt eine vollstaendige Konfiguration an und setzt die Vorgaben', () => {
		const { settings, problems } = readConfig(vollstaendig);
		expect(problems).to.deep.equal([]);
		expect(settings).to.include({
			apiKey: 'sk-live-4f2a9c7e1b8d',
			idleMs: 15 * 60_000,
			activeMs: 5 * 60_000,
			backoffMaxMs: 60 * 60_000,
			commandReserve: 6,
			commandTtlMs: 10 * 60_000,
			readParkingPosition: true,
		});
		expect(settings?.vins).to.deep.equal([VIN]);
	});

	it('beanstandet einen fehlenden Schluessel und sagt, wo er herkommt', () => {
		const { settings, problems } = readConfig({ vins: [{ vin: VIN }] });
		expect(settings).to.equal(undefined);
		expect(problems[0]).to.contain('MySkoda-App');
	});

	it('beanstandet eine fehlende Fahrzeugliste', () => {
		const { problems } = readConfig({ apiKey: 'sk-live-4f2a9c7e1b8d' });
		expect(problems).to.have.length(1);
		expect(problems[0]).to.contain('Fahrgestellnummer');
	});

	it('nimmt VINs als Tabelle und als blosse Zeichenkette', () => {
		expect(readConfig({ ...vollstaendig, vins: [VIN] }).settings?.vins).to.deep.equal([VIN]);
		expect(readConfig({ ...vollstaendig, vins: [{ vin: VIN, label: 'Enyaq' }] }).settings?.vins).to.deep.equal([
			VIN,
		]);
	});

	it('schreibt VINs gross und wirft Dubletten weg', () => {
		const { settings } = readConfig({ ...vollstaendig, vins: [{ vin: VIN.toLowerCase() }, { vin: ` ${VIN} ` }] });
		expect(settings?.vins).to.deep.equal([VIN]);
	});

	it('nennt die Zeile einer falschen VIN, aber nicht die VIN selbst', () => {
		// Ein Tippfehler in der eigenen VIN ist der Normalfall - die Meldung landet im
		// Log und das Log im Forum (E14).
		const falsch = 'TMBJB9NY5RF99999';
		const { settings, problems } = readConfig({ ...vollstaendig, vins: [{ vin: falsch }] });
		expect(settings).to.equal(undefined);
		expect(problems[0]).to.contain('Zeile 1');
		expect(problems[0]).to.not.contain(falsch);
	});

	it('lehnt I, O und Q ab - eine VIN kennt sie nicht', () => {
		const { problems } = readConfig({ ...vollstaendig, vins: [{ vin: 'TMBJB9NY5RF99999O' }] });
		expect(problems).to.have.length(1);
	});

	it('haelt die Untergrenzen der Kadenz ein', () => {
		const { settings } = readConfig({ ...vollstaendig, pollIntervalIdle: 1, pollIntervalActive: 0 });
		expect(settings?.idleMs).to.equal(5 * 60_000);
		expect(settings?.activeMs).to.equal(3 * 60_000);
	});

	it('laesst den Deckel des Backoffs nicht unter die Grundkadenz fallen', () => {
		const { settings } = readConfig({ ...vollstaendig, pollIntervalIdle: 30, pollBackoffMax: 10 });
		expect(settings?.backoffMaxMs).to.equal(30 * 60_000);
	});

	it('vertraegt Zahlen als Zeichenkette, wie sie aus manchen Formularen kommen', () => {
		const { settings } = readConfig({ ...vollstaendig, pollIntervalIdle: '20', commandReserve: '3' });
		expect(settings?.idleMs).to.equal(20 * 60_000);
		expect(settings?.commandReserve).to.equal(3);
	});

	it('haelt die Reserve zwischen 0 und 15', () => {
		expect(readConfig({ ...vollstaendig, commandReserve: 99 }).settings?.commandReserve).to.equal(15);
		expect(readConfig({ ...vollstaendig, commandReserve: -1 }).settings?.commandReserve).to.equal(0);
	});

	it('schaltet die Parkposition nur bei ausdruecklichem false ab', () => {
		expect(readConfig({ ...vollstaendig, readParkingPosition: false }).settings?.readParkingPosition).to.equal(
			false,
		);
		expect(readConfig(vollstaendig).settings?.readParkingPosition).to.equal(true);
	});

	it('haelt eine leere Konfiguration aus', () => {
		expect(readConfig(undefined).problems).to.have.length(2);
		expect(readConfig({}).settings).to.equal(undefined);
	});
});
