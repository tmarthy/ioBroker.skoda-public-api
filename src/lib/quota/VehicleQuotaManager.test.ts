import { expect } from 'chai';
import type { ApiMeta } from '../api/client';
import { VehicleQuotaManager } from './VehicleQuotaManager';

const VIN_A = 'TMBJB9NY5RF999999';
const VIN_B = 'TMBJC1NY0SF123456';

describe('quota/VehicleQuotaManager => ein Bucket pro VIN', () => {
	let clock: number;
	const now = (): number => clock;
	const response = (remaining: number): ApiMeta => ({
		consumedQuota: true,
		rateLimit: { limit: 20, remaining, resetInSeconds: 3600 },
	});

	beforeEach(() => {
		clock = Date.parse('2026-09-05T10:00:00Z');
	});

	it('haelt Headerstaende und laufende Requests je VIN getrennt', () => {
		const quota = new VehicleQuotaManager({ vins: [VIN_A, VIN_B], now });
		const permitA = quota.tryAcquire(VIN_A, 'poll');
		expect(permitA).to.not.have.property('reason');
		if ('reason' in permitA) {
			throw new Error('Poll A unerwartet abgelehnt');
		}
		quota.recordResponse(VIN_A, response(6), permitA);

		expect(quota.snapshot(VIN_A).remaining).to.equal(6);
		expect(quota.snapshot(VIN_B).remaining).to.equal(20);
		expect(quota.tryAcquire(VIN_A, 'poll')).to.have.property('reason', 'reserve');
		expect(quota.tryAcquire(VIN_B, 'poll')).to.not.have.property('reason');
	});

	it('erzeugt fuer einen Verbindungstest mit neuer VIN einen eigenen Bucket', () => {
		const quota = new VehicleQuotaManager({ vins: [VIN_A], now });
		const permit = quota.trackRequest(VIN_B);
		quota.recordResponse(VIN_B, response(3), permit);

		expect(quota.snapshot(VIN_A).remaining).to.equal(20);
		expect(quota.snapshot(VIN_B).remaining).to.equal(3);
	});
});
