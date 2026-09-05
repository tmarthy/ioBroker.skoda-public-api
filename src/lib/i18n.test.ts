import { expect } from 'chai';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pickTestTarget } from './connectionTest';
import { readConfig } from './config';
import type { Translate } from './i18n';

const root = join(__dirname, '..', '..');
const readJson = (path: string): Record<string, string> =>
	JSON.parse(readFileSync(path, 'utf8')) as Record<string, string>;
const catalogTranslate = (language: 'de' | 'en'): Translate => {
	const catalog = readJson(join(root, 'i18n', `${language}.json`));
	return (key, ...args) => {
		let text = catalog[key] ?? key;
		for (const arg of args) {
			text = text.replace('%s', String(arg));
		}
		return text;
	};
};

describe('backend i18n', () => {
	it('keeps the German and English catalogs in sync', () => {
		const en = readJson(join(root, 'i18n', 'en.json'));
		const de = readJson(join(root, 'i18n', 'de.json'));
		expect(Object.keys(de).sort()).to.deep.equal(Object.keys(en).sort());
	});

	it('returns configuration and UI-action errors in the selected language', () => {
		const de = catalogTranslate('de');
		expect(readConfig({}, de).problems[0]).to.contain('Kein API-Schlüssel');
		expect(pickTestTarget({}, {}, de))
			.to.have.nested.property('problem')
			.that.contains('Kein API-Schlüssel');

		const en = catalogTranslate('en');
		expect(readConfig({}, en).problems[0]).to.contain('No API key');
		expect(pickTestTarget({}, {}, en))
			.to.have.nested.property('problem')
			.that.contains('No API key');
	});
});

describe('admin i18n', () => {
	it('contains every UI text in every shipped language', () => {
		const config = JSON.parse(readFileSync(join(root, 'admin', 'jsonConfig.json'), 'utf8')) as unknown;
		const texts = new Set<string>();
		const visit = (value: unknown): void => {
			if (Array.isArray(value)) {
				value.forEach(visit);
				return;
			}
			if (typeof value !== 'object' || value === null) {
				return;
			}
			for (const [key, child] of Object.entries(value)) {
				if (['label', 'help', 'text', 'title'].includes(key) && typeof child === 'string') {
					texts.add(child);
				} else {
					visit(child);
				}
			}
		};
		visit(config);

		for (const language of ['de', 'en', 'es', 'fr', 'it', 'nl', 'pl', 'pt', 'ru', 'uk', 'zh-cn']) {
			const catalog = readJson(join(root, 'admin', 'i18n', `${language}.json`));
			expect(
				[...texts].filter(text => catalog[text] === undefined),
				language,
			).to.deep.equal([]);
		}
	});
});
