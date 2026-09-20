import { expect } from 'chai';
import { OBJECT_NAME_LANGUAGES } from './i18n';
import { diagnosticStates, diagnosticText, EDITOR_MESSAGES } from './diagnosticTranslations';
import { CONFIRMATION_STATUSES } from './commands/confirmation';
import { POLLING_REASONS } from './scheduler/pollingStatus';

describe('localized user-facing diagnostics', () => {
	it('covers every diagnostic code in all supported languages without changing machine values', () => {
		for (const labels of [CONFIRMATION_STATUSES, POLLING_REASONS, EDITOR_MESSAGES]) {
			for (const language of OBJECT_NAME_LANGUAGES) {
				const localized = diagnosticStates(labels, language);
				expect(Object.keys(localized)).to.deep.equal(Object.keys(labels));
				for (const [code, english] of Object.entries(labels)) {
					expect(localized[code]).to.be.a('string').and.not.equal('');
					if (language === 'en') {
						expect(localized[code]).to.equal(english);
					} else {
						expect(localized[code], `${language}/${code}`).not.to.equal(english);
					}
				}
			}
		}
	});
	it('falls back to English for unsupported languages and preserves replacement placeholders', () => {
		expect(diagnosticStates(POLLING_REASONS, 'unknown')).to.deep.equal(POLLING_REASONS);
		expect(diagnosticText('invalidField', EDITOR_MESSAGES.invalidField, 'de')).to.include('%s');
	});
});
