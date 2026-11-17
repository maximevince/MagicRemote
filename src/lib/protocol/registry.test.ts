import { describe, expect, it } from 'vitest';
import { byKey, checkValues, lookup, PARAMS } from './registry.ts';

describe('registry', () => {
	it('has unique ids and keys', () => {
		const ids = PARAMS.map((d) => `${d.group}.${d.param}`);
		expect(new Set(ids).size).toBe(ids.length);
		expect(new Set(PARAMS.map((d) => d.key)).size).toBe(PARAMS.length);
	});

	it('covers the parameters the app needs', () => {
		for (const id of ['10.1', '1.14', '1.13', '1.11', '1.12', '0.2', '0.3', '1.2', '1.3', '0.0', '0.1', '0.7', '0.8', '0.9', '10.0', '1.9', '9.0', '9.1', '9.2']) {
			const [g, p] = id.split('.').map(Number);
			expect(lookup(g, p), id).toBeDefined();
		}
		expect(byKey('media.transportMode')).toBe(lookup(10, 1));
		expect(lookup(200, 1)).toBeUndefined();
	});

	it('never retries triggers, offsets-only controls or the transport', () => {
		for (const d of PARAMS.filter((d) => d.type === 'void' && d.count === 0)) expect(d.retry, d.key).toBe('never');
		expect(lookup(10, 1)!.retry).toBe('never');
	});

	it('rejects out-of-range values instead of clamping', () => {
		const wb = lookup(1, 2)!;
		expect(checkValues(wb, [5600, 10])).toBe(true);
		expect(checkValues(wb, [5600, 51])).toBe(false);
		expect(checkValues(wb, [2400, 0])).toBe(false);
		expect(checkValues(wb, [5600])).toBe(false);
		const shutter = lookup(1, 11)!;
		expect(checkValues(shutter, [18000])).toBe(true);
		expect(checkValues(shutter, [99])).toBe(false);
	});

	it('applies a range to one element only when asked', () => {
		const iris = lookup(0, 2)!;
		expect(checkValues(iris, [4.17, 0])).toBe(true);
		expect(checkValues(iris, [-16])).toBe(true); // no lens
		expect(checkValues(iris, [17, 0])).toBe(false);
	});

	it('checks string limits in bytes', () => {
		const cam = lookup(12, 5)!;
		expect(checkValues(cam, 'A')).toBe(true);
		expect(checkValues(cam, 'AB')).toBe(false);
		expect(checkValues(cam, 'é')).toBe(false);
	});

	it('accepts any slot count for per-slot status', () => {
		expect(checkValues(lookup(9, 2)!, [0, 0, 27023, 0])).toBe(true);
		expect(checkValues(lookup(9, 1)!, [0, 0, 1])).toBe(true);
		expect(checkValues(lookup(9, 1)!, [0, 2])).toBe(false);
	});
});
