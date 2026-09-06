const fs = require('fs');
const path = require('path');
const assert = require('node:assert/strict');
const { tests } = require('@iobroker/testing');

// Validate the package files
tests.packageFiles(path.join(__dirname, '..'));

describe('io-package metadata', () => {
	it('keeps at most seven news entries for the repository builder', () => {
		const ioPackage = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'io-package.json'), 'utf8'));
		assert.ok(Object.keys(ioPackage.common.news).length <= 7);
	});
});

describe('admin translations', () => {
	it('does not leave longer texts untranslated', () => {
		const translationsDir = path.join(__dirname, '..', 'admin', 'i18n');
		const english = JSON.parse(fs.readFileSync(path.join(translationsDir, 'en.json'), 'utf8'));

		for (const file of fs.readdirSync(translationsDir)) {
			if (!file.endsWith('.json') || file === 'en.json') continue;

			const translations = JSON.parse(fs.readFileSync(path.join(translationsDir, file), 'utf8'));
			for (const [key, value] of Object.entries(translations)) {
				const wordCount = key.trim().split(/\s+/).length;
				assert.ok(
					wordCount <= 5 || value !== english[key],
					`${file}: translation is identical to English: ${key}`,
				);
			}
		}
	});
});
