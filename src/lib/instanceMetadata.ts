import { translated } from './i18n';

const CONNECTION_ID = 'info.connection';

/** Local ioBroker object access; no vehicle API request is involved. */
export interface InstanceMetadataApi {
	/** Read an instance object from ioBroker's object database. */
	getObjectAsync(id: string): ioBroker.GetObjectPromise;
	/** Extend only changed metadata on an existing instance object. */
	extendObjectAsync(id: string, object: ioBroker.PartialObject): ioBroker.SetObjectPromise;
}

/**
 * Instance objects are created during installation and may retain an older name
 * after an adapter update. Add only missing translations, preserving custom names.
 *
 * @param api Local ioBroker object database access.
 */
export async function completeConnectionName(api: InstanceMetadataApi): Promise<void> {
	const object = await api.getObjectAsync(CONNECTION_ID);
	if (object?.type !== 'state') {
		return;
	}
	const current = object.common.name;
	if (typeof current !== 'object' || current === null || Array.isArray(current)) {
		return;
	}
	const expected = translated('Device or service connected', 'Gerät oder Dienst verbunden');
	const missing = Object.fromEntries(Object.entries(expected).filter(([language]) => !(language in current)));
	if (Object.keys(missing).length) {
		await api.extendObjectAsync(CONNECTION_ID, { common: { name: { ...current, ...missing } } });
	}
}
