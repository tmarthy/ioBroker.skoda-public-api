// ioBroker eslint template configuration file for js and ts files
// Please note that esm or react based modules need additional modules loaded.
import config from '@iobroker/eslint-config';

export default [
	...config,
	{
		// specify files to exclude from linting here
		ignores: [
			'.dev-server/',
			// Generat aus der OpenAPI-Spec - wird von 'npm run codegen' erzeugt.
			'src/**/*.generated.ts',
			'.vscode/',
			'*.test.js',
			'test/**/*.js',
			'*.config.mjs',
			'build',
			'dist',
			'admin/words.js',
			'admin/admin.d.ts',
			'admin/blockly.js',
			'**/adapter-config.d.ts',
			'widgets/**/*.js'
		],
	},
	{
		// Testcode und Testdoppel: Die tragenden Teile sind ausfuehrlich kommentiert,
		// aber jedes Feld einer Options-Schnittstelle im Mock einzeln zu bedoken bringt
		// keinen Erkenntnisgewinn und verwaessert die Kommentare, die wirklich zaehlen.
		files: ['test/**/*.ts', 'src/**/*.test.ts'],
		rules: {
			'jsdoc/require-jsdoc': 'off',
		},
	},
	{
		// you may disable some 'jsdoc' warnings - but using jsdoc is highly recommended
		// as this improves maintainability. jsdoc warnings will not block build process.
		rules: {
			// 'jsdoc/require-jsdoc': 'off',
			// 'jsdoc/require-param': 'off',
			// 'jsdoc/require-param-description': 'off',
			// 'jsdoc/require-returns-description': 'off',
			// 'jsdoc/require-returns-check': 'off',
		},
	},
];