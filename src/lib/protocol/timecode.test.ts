import { describe, expect, it } from 'vitest';
import { fromHex } from './codec.ts';
import { decodeTimecode, formatTimecode, timecodeFromBcd, timecodeToBcd } from './timecode.ts';

describe('timecode', () => {
	it('decodes the 12-byte packet from the Timecode characteristic (6K G2 capture)', () => {
		const tc = decodeTimecode(fromHex('ff0800ff0904030016152407'))!;
		expect(tc).toMatchObject({ hours: 7, minutes: 24, seconds: 15, frames: 16, dropFrame: false });
		expect(formatTimecode(tc)).toBe('07:24:15:16');
	});

	it('matches the PDF example 09:12:53:10 = 0x09125310', () => {
		expect(formatTimecode(timecodeFromBcd(0x09125310))).toBe('09:12:53:10');
		expect(timecodeToBcd({ hours: 9, minutes: 12, seconds: 53, frames: 10 })).toBe(0x09125310);
	});

	it('reads bit 31 as drop frame and shows it with semicolons', () => {
		const tc = timecodeFromBcd(0x80000000 | 0x23595929);
		expect(tc).toMatchObject({ hours: 23, minutes: 59, seconds: 59, frames: 29, dropFrame: true });
		expect(formatTimecode(tc)).toBe('23;59;59;29');
		expect(timecodeToBcd({ hours: 23, minutes: 59, seconds: 59, frames: 29, dropFrame: true })).toBe(0xa3595929);
	});

	it('decodes a drop-frame packet from the characteristic', () => {
		// BCD 0x81020304 little-endian in bytes 8..11
		const tc = decodeTimecode(fromHex('ff0800ff0904030004030281'))!;
		expect(tc.dropFrame).toBe(true);
		expect(formatTimecode(tc)).toBe('01;02;03;04');
	});

	it('masks the hours to 6 bits so bit 30 does not leak in', () => {
		expect(timecodeFromBcd(0x40000000 | 0x01000000).hours).toBe(1);
	});

	it('marks fields with non-decimal digits as invalid', () => {
		const tc = timecodeFromBcd(0x0912ff10);
		expect(tc.seconds).toBeNull();
		expect(formatTimecode(tc)).toBe('09:12:--:10');
	});

	it('accepts a bare 4-byte value and rejects anything else', () => {
		expect(formatTimecode(decodeTimecode(fromHex('10531209'))!)).toBe('09:12:53:10');
		expect(decodeTimecode(fromHex('ff08'))).toBeNull();
		expect(decodeTimecode(fromHex('ff0800000a0103000000000000'))).toBeNull();
	});

	it('works on a view into a larger buffer', () => {
		const big = fromHex('aaaa' + 'ff0800ff0904030016152407');
		expect(formatTimecode(decodeTimecode(big.subarray(2))!)).toBe('07:24:15:16');
	});

	it('rejects out-of-range fields when encoding', () => {
		expect(() => timecodeToBcd({ hours: 0, minutes: 60, seconds: 0, frames: 0 })).toThrow(RangeError);
	});
});
