import { expect } from 'chai';
import { SECRET_PLACEHOLDER, VIN_PLACEHOLDER, createSanitizer, sanitize } from './sanitize';

/**
 * Die Maskierung ist die einzige Schutzschicht zwischen dem URL-Pfad und dem
 * ioBroker-Log (E14). Sie muss zwei Dinge zugleich koennen: nichts durchlassen, was
 * eine VIN oder ein Schluessel ist, und lesbar lassen, was keins ist.
 */
describe('api/sanitize => Maskierung von VIN und Schluessel', () => {
	const VIN = 'TMBJB9NY5RF999999';
	const KEY = 'sk-live-4f2a9c7e1b8d';

	describe('VIN', () => {
		it('maskiert die VIN im URL-Pfad, wo sie immer steht', () => {
			const masked = sanitize(`GET /api/v1/vehicles/${VIN}/charging/start fehlgeschlagen`);
			expect(masked).to.equal(`GET /api/v1/vehicles/${VIN_PLACEHOLDER}/charging/start fehlgeschlagen`);
		});

		it('maskiert sie auch in JSON und hinter einem Unterstrich', () => {
			expect(sanitize(`{"instance":"/api/v1/vehicles/${VIN}"}`)).to.not.contain(VIN);
			expect(sanitize(`vehicle_${VIN}`)).to.equal(`vehicle_${VIN_PLACEHOLDER}`);
		});

		it('maskiert mehrere VINs in einer Meldung', () => {
			const other = 'TMBJC1NY0SF123456';
			const masked = sanitize(`${VIN} und ${other}`);
			expect(masked).to.equal(`${VIN_PLACEHOLDER} und ${VIN_PLACEHOLDER}`);
		});

		it('laesst laengere Kennungen in Ruhe - 18 Stellen sind keine VIN', () => {
			expect(sanitize(`${VIN}9`)).to.equal(`${VIN}9`);
			expect(sanitize(`x${VIN}`)).to.equal(`x${VIN}`);
		});

		it('laesst Text in Ruhe, der die VIN-Zeichen gar nicht erfuellt', () => {
			// I, O und Q sind in einer VIN ausgeschlossen, Kleinbuchstaben ebenso.
			expect(sanitize('OPERATIONNOTALLOW')).to.equal('OPERATIONNOTALLOW');
			expect(sanitize('abcdefghjklmnpr09')).to.equal('abcdefghjklmnpr09');
		});
	});

	describe('Schluessel und weitere Geheimnisse', () => {
		it('maskiert den Schluessel an jeder Stelle', () => {
			const masked = sanitize(`X-API-Key: ${KEY} abgelehnt (${KEY})`, { apiKey: KEY });
			expect(masked).to.equal(`X-API-Key: ${SECRET_PLACEHOLDER} abgelehnt (${SECRET_PLACEHOLDER})`);
		});

		it('maskiert weitere hinterlegte Geheimnisse, etwa den S-PIN', () => {
			const masked = sanitize('S-PIN 12345678 abgelehnt', { secrets: ['12345678'] });
			expect(masked).to.equal(`S-PIN ${SECRET_PLACEHOLDER} abgelehnt`);
		});

		it('maskiert das laengere Geheimnis zuerst', () => {
			// Sonst zerschneidet die kuerzere Ersetzung die laengere und laesst deren
			// Rest im Klartext stehen.
			const masked = sanitize('token abcdefghij vs abcdefgh', { secrets: ['abcdefgh', 'abcdefghij'] });
			expect(masked).to.equal(`token ${SECRET_PLACEHOLDER} vs ${SECRET_PLACEHOLDER}`);
		});

		it('ignoriert zu kurze Geheimnisse, statt die Meldung zu zerstoeren', () => {
			// Ein leeres oder einstelliges Feld in der Instanzkonfiguration ist kein
			// Schluessel - waere es eins, waere die Meldung unlesbar.
			expect(sanitize('a b c', { apiKey: '' })).to.equal('a b c');
			expect(sanitize('a b c', { apiKey: 'a' })).to.equal('a b c');
		});

		it('behandelt Sonderzeichen im Schluessel woertlich, nicht als Muster', () => {
			const tricky = 'a.*+?[key]';
			expect(sanitize(`Schluessel ${tricky} weg`, { apiKey: tricky })).to.equal(
				`Schluessel ${SECRET_PLACEHOLDER} weg`,
			);
			expect(sanitize('aXXXXXXXXX weg', { apiKey: tricky })).to.equal('aXXXXXXXXX weg');
		});
	});

	describe('beliebige Werte', () => {
		it('nimmt einen Fehler samt Ursachenkette', () => {
			const cause = new Error(`connect ECONNREFUSED bei ${VIN}`);
			const masked = sanitize(new TypeError('fetch failed', { cause }));
			expect(masked).to.contain('TypeError: fetch failed');
			expect(masked).to.contain('cause:');
			expect(masked).to.contain(VIN_PLACEHOLDER);
			expect(masked).to.not.contain(VIN);
		});

		it('nimmt Objekte, null und undefined, ohne zu werfen', () => {
			expect(sanitize({ vin: VIN })).to.equal(`{"vin":"${VIN_PLACEHOLDER}"}`);
			expect(sanitize(undefined)).to.equal('undefined');
			expect(sanitize(null)).to.equal('null');
			expect(sanitize(42)).to.equal('42');
		});

		it('haelt auch nicht darstellbare Werte aus', () => {
			const circular: Record<string, unknown> = {};
			circular.self = circular;
			expect(() => sanitize(circular)).to.not.throw();
			expect(sanitize(circular)).to.equal('[not printable]');
		});
	});

	it('bindet createSanitizer an die Geheimnisse der Instanz', () => {
		const masked = createSanitizer({ apiKey: KEY })(`${KEY} fuer ${VIN}`);
		expect(masked).to.equal(`${SECRET_PLACEHOLDER} fuer ${VIN_PLACEHOLDER}`);
	});
});
