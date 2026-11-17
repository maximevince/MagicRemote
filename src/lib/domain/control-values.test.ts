import { describe, expect, it } from 'vitest';
import { fixed16 } from '../protocol/index.ts';
import {
	AV_MAX,
	AV_MIN,
	avToFNumber,
	irisStep,
	isNoLens,
	ISO_STOPS,
	kelvinStep,
	SHUTTER_SPEEDS,
	speedsFor,
	stepInList,
	WB_PRESETS
} from './control-values.ts';

describe('stepInList', () => {
	it('moves to the neighbour of a listed value', () => {
		expect(stepInList(ISO_STOPS, 400, 1)).toBe(500);
		expect(stepInList(ISO_STOPS, 400, -1)).toBe(320);
	});

	it('moves an off-list value to the nearest listed value in that direction', () => {
		expect(stepInList(ISO_STOPS, 450, 1)).toBe(500);
		expect(stepInList(ISO_STOPS, 450, -1)).toBe(400);
	});

	it('stops at the ends and without a value', () => {
		expect(stepInList(ISO_STOPS, 25600, 1)).toBeNull();
		expect(stepInList(ISO_STOPS, 100, -1)).toBeNull();
		expect(stepInList(ISO_STOPS, undefined, 1)).toBeNull();
	});
});

describe('shutter speeds', () => {
	it('drops speeds longer than one frame', () => {
		expect(speedsFor(50)[0]).toBe(50);
		expect(speedsFor(50)).not.toContain(48);
		expect(speedsFor(null)).toBe(SHUTTER_SPEEDS);
	});
});

describe('iris', () => {
	it('converts AV to f-numbers', () => {
		expect(avToFNumber(4)).toBeCloseTo(4);
		expect(avToFNumber(4.1709)).toBeCloseTo(4.24, 2);
		expect(avToFNumber(5)).toBeCloseTo(5.66, 2);
	});

	it('steps a third of a stop onto the third-stop grid', () => {
		expect(irisStep(4, 1)).toBeCloseTo(13 / 3);
		expect(irisStep(4, -1)).toBeCloseTo(11 / 3);
		// The captured lens value sits between marks: the first step lands on the next mark.
		expect(irisStep(4.1709, 1)).toBeCloseTo(13 / 3);
		expect(irisStep(4.1709, -1)).toBeCloseTo(4);
	});

	it('treats a value the lens reports just off a mark as that mark', () => {
		const reported = fixed16.toFloat(0x22b8); // sent 0x22ab (13/3)
		expect(irisStep(reported, -1)).toBeCloseTo(4);
		expect(irisStep(reported, 1)).toBeCloseTo(14 / 3);
	});

	it('always makes progress through fixed16 rounding', () => {
		let av = 2;
		for (let i = 0; i < 12; i++) {
			const next = fixed16.toFloat(fixed16.fromFloat(irisStep(av, 1)));
			expect(next).toBeGreaterThan(av + 0.3);
			av = next;
		}
		for (let i = 0; i < 12; i++) {
			const next = fixed16.toFloat(fixed16.fromFloat(irisStep(av, -1)));
			expect(next).toBeLessThan(av - 0.3);
			av = next;
		}
	});

	it('stays inside the lens range', () => {
		expect(irisStep(AV_MAX, 1)).toBe(AV_MAX);
		expect(irisStep(AV_MIN, -1)).toBe(AV_MIN);
	});

	it('recognises the no-lens value', () => {
		expect(isNoLens(-16)).toBe(true);
		expect(isNoLens(fixed16.toFloat(-32768))).toBe(true);
		expect(isNoLens(-1)).toBe(false);
		expect(isNoLens(undefined)).toBe(false);
	});
});

describe('white balance', () => {
	it('has the six presets', () => {
		expect(WB_PRESETS.map((p) => p.kelvin)).toEqual([3200, 4000, 4500, 5600, 6500, 7500]);
	});

	it('steps Kelvin on the 100 K grid within 2500–10000', () => {
		expect(kelvinStep(5600, 1)).toBe(5700);
		expect(kelvinStep(5650, 1)).toBe(5700);
		expect(kelvinStep(5650, -1)).toBe(5600);
		expect(kelvinStep(10000, 1)).toBe(10000);
		expect(kelvinStep(2500, -1)).toBe(2500);
	});
});
