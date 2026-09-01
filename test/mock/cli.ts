/**
 * Startet den Mock als eigenstaendigen Entwicklungsserver.
 *
 *   npm run mock
 *   SKODA_MOCK_PORT=8099 SKODA_MOCK_FIXTURE=synth-idle npm run mock
 *
 * Danach den Adapter mit SKODA_API_BASE_URL auf diesen Server zeigen lassen.
 * Steuerung im laufenden Betrieb:
 *   curl 'http://127.0.0.1:8099/__mock/scenario?value=rate-limit-exceeded'
 *   curl 'http://127.0.0.1:8099/__mock/reset'
 *   curl 'http://127.0.0.1:8099/__mock'
 */
import { DEFAULT_API_KEY, DEFAULT_VIN, MockSkodaApi } from './server';

const port = Number(process.env.SKODA_MOCK_PORT ?? 8099);
const mock = new MockSkodaApi({
	fixture: process.env.SKODA_MOCK_FIXTURE ?? 'synth-idle',
	apiKey: process.env.SKODA_MOCK_API_KEY ?? DEFAULT_API_KEY,
	vin: process.env.SKODA_MOCK_VIN ?? DEFAULT_VIN,
	rateLimit: Number(process.env.SKODA_MOCK_RATE_LIMIT ?? 20),
	commandLatencyMs: Number(process.env.SKODA_MOCK_COMMAND_LATENCY_MS ?? 0),
});

void mock.start(port).then(url => {
	console.log(`Mock der MyŠkoda Public API laeuft auf ${url}`);
	console.log(`  API-Key : ${process.env.SKODA_MOCK_API_KEY ?? DEFAULT_API_KEY}`);
	console.log(`  VIN     : ${process.env.SKODA_MOCK_VIN ?? DEFAULT_VIN}`);
	console.log(`  Budget  : ${mock.quota.remaining} von ${mock.quota.limit} pro Stunde`);
	console.log('');
	console.log(`  curl -H "X-API-Key: ${process.env.SKODA_MOCK_API_KEY ?? DEFAULT_API_KEY}" \\`);
	console.log(`    ${url}/api/v1/vehicles/${process.env.SKODA_MOCK_VIN ?? DEFAULT_VIN}`);
});

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
	process.on(signal, () => {
		void mock.stop().then(() => process.exit(0));
	});
}
