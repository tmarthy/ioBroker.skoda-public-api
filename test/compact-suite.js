'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { fork } = require('node:child_process');
const { expect } = require('chai');

/**
 * Runs actual adapter factories inside js-controller's compact group process.
 * @param {any} deps Existing integration helpers and suite registration.
 */
module.exports = function defineCompactSuite({ suite, configure, encrypt, getState, setState, readState, waitFor, delay, MockSkodaApi, DEFAULT_API_KEY, DEFAULT_VIN }) {
	// The js-controller development version used by @iobroker/testing can terminate
	// its directly launched compact-group controller on Windows before its zero-delay
	// instance-start timers run. The platform-independent compact lifecycle coverage
	// remains in the unit suite, while this real controller test runs on Unix hosts.
	if (process.platform === 'win32') {
		return;
	}
	suite('Compact group 1', /** @param {() => any} getHarness Test harness factory. */ getHarness => {
		it('isolates two instances and restarts one in the same group process', async function () {
			this.timeout(180000);
			const harness = getHarness();
			const secondVin = 'TMBJB9NY5RF888888';
			const secondKey = 'mock-second-key';
			const a = 'skoda-public-api.0';
			const b = 'skoda-public-api.1';
			const mockA = new MockSkodaApi();
			const mockB = new MockSkodaApi({ vin: secondVin, apiKey: secondKey });
			const configPath = path.join(harness.testDir, 'iobroker-data', 'iobroker.json');
			const originalConfig = fs.readFileSync(configPath, 'utf8');
			/** @type {import("node:child_process").ChildProcess | undefined} */
			let group;
			let output = '';
			/** @type {any[]} */
			const traces = [];
			const object = /** @param {string} id Object ID. */ id => harness.objects.getObjectAsync ? harness.objects.getObjectAsync(id) : harness.objects.getObject(id);
			const save = /** @param {string} id Object ID. @param {any} value Object value. */ (id, value) => harness.objects.setObjectAsync ? harness.objects.setObjectAsync(id, value) : harness.objects.setObject(id, value);
			try {
				const urlA = await mockA.start();
				const urlB = await mockB.start();
				await configure(harness);
				const config = JSON.parse(originalConfig);
				config.system.compact = true;
				fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
				const first = await object(`system.adapter.${a}`);
				// The harness has no Admin installation; its UI dependency is irrelevant to this backend test.
				first.common.globalDependencies = [];
				const metadata = JSON.parse(fs.readFileSync(path.join(harness.testAdapterDir, 'io-package.json'), 'utf8'));
				expect(metadata.common.compact).to.equal(true);
				first.common.version = metadata.common.version;
				Object.assign(first.common, { compact: true, runAsCompactMode: true, compactGroup: 1, host: os.hostname() });
				await save(first._id, first);
				const second = structuredClone(first);
				second._id = `system.adapter.${b}`;
				second.native.backendLanguage = 'en';
				second.native.vins = [{ vin: secondVin, label: 'Second vehicle' }];
				const system = await object('system.config');
				second.native.apiKey = encrypt(system.native.secret, secondKey);
				await save(second._id, second);
				group = fork(path.join(harness.testControllerDir, 'build/cjs/compactgroupController.js'), ['1', '--console'], {
					cwd: harness.testControllerDir,
					execArgv: ['--require', path.join(__dirname, 'preload-api-redirect.js')],
					env: { ...process.env, SKODA_TEST_API_BASE_URL: urlA, SKODA_TEST_API_ROUTES: JSON.stringify({ [secondKey]: urlB }) },
					silent: true,
				});
				group.stdout?.on('data', data => { output += data; });
				group.stderr?.on('data', data => { output += data; });
				group.on('message', /** @param {any} message Test trace. */ message => { if (message?.event === 'skoda-test-request') traces.push(message); });
				for (const [instance, vin] of [[a, DEFAULT_VIN], [b, secondVin]]) {
					await readState(harness, `${instance}.${vin}.odometer.mileageInKm`, 60000);
					expect((await readState(harness, `system.adapter.${instance}.compactMode`)).val).to.equal(true);
				}
				expect(traces).to.have.length(2);
				expect(new Set(traces.map(trace => trace.pid))).to.deep.equal(new Set([group.pid]));
				expect(traces.map(trace => trace.key).sort()).to.deep.equal([DEFAULT_API_KEY, secondKey].sort());
				// The harness' sendTo callback IDs are shared by both compact instances and
				// can therefore associate the other instance's reply on slower runners.
				// Instance-prefixed startup logs verify both local translators without that
				// test-harness race. The ordinary integration suite covers testConnection.
				expect(output).to.match(/skoda-public-api\.0 .*1 Fahrzeug\(e\), Abfrageintervalle/);
				expect(output).to.match(/skoda-public-api\.1 .*1 vehicle\(s\), polling intervals/);
				await setState(harness, `${a}.${DEFAULT_VIN}.charging.start`, { val: true, ack: false });
				await waitFor('compact command A', async () => (await getState(harness, `${a}.${DEFAULT_VIN}.info.lastCommand.result`))?.val === 'SENT');
				await waitFor('compact verification poll A', async () => (await getState(harness, `${a}.${DEFAULT_VIN}.charging.status.state`))?.val === 'CHARGING', 85000);
				first.common.enabled = false;
				await save(first._id, first);
				await waitFor('compact instance A stopped', async () => (await getState(harness, `system.adapter.${a}.alive`))?.val === false);
				const requestCount = mockA.requests.length;
				const keys = await harness.states.getKeys(`${a}.*`);
				const before = await harness.states.getStates(keys);
				await setState(harness, `${b}.${secondVin}.charging.start`, { val: true, ack: false });
				await waitFor('compact command B after A stopped', async () => (await getState(harness, `${b}.${secondVin}.info.lastCommand.result`))?.val === 'SENT');
				await delay(1500);
				expect(await harness.states.getStates(keys)).to.deep.equal(before);
				expect(mockA.requests.length).to.equal(requestCount);
				expect((await getState(harness, `system.adapter.${b}.alive`)).val).to.equal(true);
				first.common.enabled = true;
				await save(first._id, first);
				await waitFor('compact instance A restarted', async () => (await getState(harness, `system.adapter.${a}.alive`))?.val === true);
				// The persisted quota correctly delays ordinary polling after restart.
				const answer = await new Promise(resolve => harness.sendTo(a, 'testConnection', {}, resolve));
				expect(answer.result).to.be.a('string');
				expect(mockA.requests.length).to.equal(requestCount + 1);
				expect(traces[traces.length - 1].pid).to.equal(group.pid);
				expect((await getState(harness, `system.adapter.${a}.compactMode`)).val).to.equal(true);

			} catch (error) {
				console.error(output);
				throw error;
			} finally {
				if (group && group.exitCode === null) {
					const exited = new Promise(resolve => group?.once('exit', resolve));
					group.kill('SIGTERM');
					const force = setTimeout(() => group?.kill('SIGKILL'), 5000);
					await exited;
					clearTimeout(force);
				}
				fs.writeFileSync(configPath, originalConfig);
				await Promise.all([mockA.stop(), mockB.stop()]);
			}
			expect(output).not.to.match(/unhandled|Fallback to normal start|Unexpected error|Error during shutdown/i);
		});
	});
};
