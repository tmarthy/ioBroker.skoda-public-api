import { expect } from 'chai';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { FakeAdapter } from '../../test/helpers/fakeAdapter';
import { OBJECT_NAME_LANGUAGES } from './i18n';
import { completeConnectionName } from './instanceMetadata';

const ID = 'info.connection';
const completeName = (): Record<string, string> => {
	const ioPackage = JSON.parse(readFileSync(path.join(__dirname, '../../io-package.json'), 'utf8'));
	return ioPackage.instanceObjects.find((object: { _id: string }) => object._id === ID).common.name;
};

describe('instance metadata migration', () => {
	it('adds missing translations to an existing connection object', async () => {
		const adapter = new FakeAdapter();
		await adapter.setObjectNotExistsAsync(ID, {
			type: 'state',
			common: {
				name: { en: 'Device or service connected', de: 'Gerät oder Dienst verbunden' },
				type: 'boolean',
				role: 'indicator.connected',
				read: true,
				write: false,
			},
			native: {},
		});
		await completeConnectionName(adapter);
		const actual = adapter.objects.get(ID)!.common!.name;
		expect(actual).to.deep.equal(completeName());
		expect(Object.keys(actual)).to.have.members([...OBJECT_NAME_LANGUAGES]);
	});

	it('preserves customized translations and is idempotent', async () => {
		const adapter = new FakeAdapter();
		await adapter.setObjectNotExistsAsync(ID, {
			type: 'state',
			common: {
				name: { en: 'My connection', de: 'Meine Verbindung', fr: 'Ma connexion' },
				type: 'boolean',
				role: 'indicator.connected',
				read: true,
				write: false,
			},
			native: {},
		});
		await completeConnectionName(adapter);
		const name = adapter.objects.get(ID)!.common!.name;
		expect(name).to.include({ en: 'My connection', de: 'Meine Verbindung', fr: 'Ma connexion' });
		await completeConnectionName(adapter);
		expect(adapter.objects.get(ID)!.common!.name).to.deep.equal(name);
	});

	it('leaves a custom string name untouched', async () => {
		const adapter = new FakeAdapter();
		await adapter.setObjectNotExistsAsync(ID, {
			type: 'state',
			common: { name: 'My connection', type: 'boolean', role: 'indicator.connected', read: true, write: false },
			native: {},
		});
		await completeConnectionName(adapter);
		expect(adapter.objects.get(ID)!.common!.name).to.equal('My connection');
	});
});
