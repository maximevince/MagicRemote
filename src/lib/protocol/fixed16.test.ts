import { describe, expect, it } from 'vitest';
import { FIXED16_MAX, fromFloat, toFloat } from './fixed16.ts';

describe('fixed16', () => {
	it('matches the protocol examples', () => {
		expect(fromFloat(0.15)).toBe(0x0133);
		expect(fromFloat(-0.3) & 0xffff).toBe(0xfd9a);
		expect(fromFloat(1.0)).toBe(0x0800);
	});

	it('covers the ends of the range', () => {
		expect(fromFloat(-16)).toBe(-32768);
		expect(fromFloat(FIXED16_MAX)).toBe(32767);
		expect(FIXED16_MAX).toBeCloseTo(15.9995, 4);
		expect(toFloat(-32768)).toBe(-16);
		expect(toFloat(32767)).toBe(FIXED16_MAX);
	});

	it('rejects values that do not fit instead of wrapping', () => {
		expect(() => fromFloat(16)).toThrow(RangeError);
		expect(() => fromFloat(-16.001)).toThrow(RangeError);
		expect(() => fromFloat(Number.NaN)).toThrow(RangeError);
		expect(() => fromFloat(Infinity)).toThrow(RangeError);
	});

	it('reads both signed values and unsigned 16-bit patterns', () => {
		expect(toFloat(0xfd9a)).toBe(-614 / 2048);
		expect(toFloat(-614)).toBe(-614 / 2048);
		expect(toFloat(0xffff)).toBe(-1 / 2048);
		expect(() => toFloat(65536)).toThrow(RangeError);
		expect(() => toFloat(1.5)).toThrow(RangeError);
	});

	it('rounds to the nearest step and never returns -0', () => {
		expect(fromFloat(1 / 4096 - 1e-9)).toBe(0);
		expect(Object.is(fromFloat(-0.0001), 0)).toBe(true);
		expect(fromFloat(0.5 / 2048 + 1e-9)).toBe(1);
	});

	it('round-trips every step exactly', () => {
		for (let raw = -32768; raw <= 32767; raw += 97) expect(fromFloat(toFloat(raw))).toBe(raw);
	});
});
