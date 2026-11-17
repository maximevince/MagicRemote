import { describe, expect, it } from 'vitest';
import { decodePacket, toHex } from './codec.ts';
import {
	aperturePacket,
	autoAperturePacket,
	autoFocusPacket,
	autoWhiteBalancePacket,
	focusOffsetPacket,
	gainPacket,
	isoPacket,
	shutterAnglePacket,
	shutterSpeedPacket,
	whiteBalancePacket
} from './control-packets.ts';
import { checkValues, lookup } from './registry.ts';

describe('control packets', () => {
	it.each([
		['ISO 800', isoPacket(800), 'ff080000010e030020030000'],
		['ISO 25600', isoPacket(25600), 'ff080000010e030000640000'],
		['gain +6 dB', gainPacket(6), 'ff050000010d010006000000'],
		['gain -12 dB', gainPacket(-12), 'ff050000010d0100f4000000'],
		['shutter 180°', shutterAnglePacket(18000), 'ff080000010b030050460000'],
		['shutter 172.8°', shutterAnglePacket(17280), 'ff080000010b030080430000'],
		['shutter 1/50', shutterSpeedPacket(50), 'ff080000010c030032000000'],
		['iris AV 4 (f/4)', aperturePacket(4), 'ff0600000002800000200000'],
		['auto iris', autoAperturePacket(), 'ff04000000050000'],
		['WB 5600K +10', whiteBalancePacket(5600, 10), 'ff08000001020200e0150a00'],
		['WB 3200K -5', whiteBalancePacket(3200, -5), 'ff08000001020200800cfbff'],
		['auto WB', autoWhiteBalancePacket(), 'ff04000001030000'],
		['autofocus', autoFocusPacket(), 'ff04000000010000'],
		['focus far +0.1', focusOffsetPacket(0.1), 'ff06000000008001cd000000'],
		['focus near -0.01', focusOffsetPacket(-0.01), 'ff06000000008001ecff0000']
	])('%s', (_name, bytes, hex) => {
		expect(toHex(bytes)).toBe(hex);
		expect(bytes.length % 4).toBe(0);
		expect(bytes.length).toBeLessThanOrEqual(20);
	});

	it('matches the official autofocus example apart from the destination', () => {
		// PDF: "trigger instantaneous autofocus on camera 4" = 04 04 00 00 00 01 00 00
		expect(toHex(autoFocusPacket().subarray(1))).toBe('04000000010000');
	});

	it('decodes back to what the registry accepts', () => {
		const cases: [Uint8Array, number, number][] = [
			[isoPacket(400), 1, 14],
			[shutterAnglePacket(18000), 1, 11],
			[shutterSpeedPacket(48), 1, 12],
			[aperturePacket(4.1709), 0, 2],
			[whiteBalancePacket(5600, 10), 1, 2]
		];
		for (const [bytes, g, p] of cases) {
			const d = decodePacket(bytes);
			expect(d.op).toBe('assign');
			expect(checkValues(lookup(g, p)!, d.values!)).toBe(true);
		}
	});

	it('clamps an aperture write into what fixed16 and the lens range carry', () => {
		expect(decodePacket(aperturePacket(20)).values![0]).toBeCloseTo(15.99, 2);
		expect(decodePacket(aperturePacket(-5)).values).toEqual([-1]);
	});

	it('clamps an accumulated focus offset to one full travel', () => {
		expect(decodePacket(focusOffsetPacket(3)).values).toEqual([1]);
		expect(decodePacket(focusOffsetPacket(-3)).values).toEqual([-1]);
	});

	it('refuses values that are not numbers', () => {
		expect(() => isoPacket(Number.NaN)).toThrow(RangeError);
	});
});
