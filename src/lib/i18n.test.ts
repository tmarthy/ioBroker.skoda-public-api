import { expect } from 'chai';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { translateFallback } from './i18n';

const root = join(__dirname, '..', '..');
const readJson = (path: string): Record<string, string> =>
	JSON.parse(readFileSync(path, 'utf8')) as Record<string, string>;
describe('backend messages', () => {
	it('keeps messages in English and substitutes all placeholders', () => {
		expect(translateFallback('No vehicle entered.')).to.equal('No vehicle entered.');
		expect(translateFallback('Row %s: %s', 2, 'invalid')).to.equal('Row 2: invalid');
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
