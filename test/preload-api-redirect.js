'use strict';

// Test-only preload for the black-box adapter integration test. It redirects requests
// for the fixed production origin to the local mock without adding a production
// process.env escape hatch.
const productionOrigin = 'https://public.api.connect.skoda-auto.cz';
const mockBaseUrl = process.env.SKODA_TEST_API_BASE_URL;
const originalFetch = globalThis.fetch;

if (mockBaseUrl && originalFetch) {
	globalThis.fetch = (input, init) => {
		const inputUrl = input instanceof Request ? input.url : input;
		const url = new URL(inputUrl);
		if (url.origin !== productionOrigin) {
			return originalFetch(input, init);
		}
		const mock = new URL(mockBaseUrl);
		url.protocol = mock.protocol;
		url.host = mock.host;
		const redirected = input instanceof Request ? new Request(url, input) : url;
		return originalFetch(redirected, init);
	};
}
