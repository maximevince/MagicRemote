import { describe, expect, it } from 'vitest';
import { decodePacket, toHex } from './codec.ts';
import { buildTransportPacket, ClipStep, clipStepPacket, PlaybackSpeed } from './playback-packets.ts';
import { buildRecordPacket, TransportFlag, TransportMode } from './transport-recipes.ts';

// What the Pocket 6K G2 would report in playback, paused: the preview report with mode 1.
const PAUSED = [1, 0, 16, 0, 1, 3];
const PLAYING = [1, 1, 16, 0, 1, 3];

describe('10.2 clip step', () => {
	it('is a single int8 assign, zero-padded', () => {
		expect(toHex(clipStepPacket(ClipStep.previous))).toBe('ff0500000a02010000000000');
		expect(toHex(clipStepPacket(ClipStep.next))).toBe('ff0500000a02010001000000');
		const d = decodePacket(clipStepPacket(ClipStep.next));
		expect(d).toMatchObject({ group: 10, param: 2, type: 'int8', op: 'assign', values: [1] });
	});

	it('rejects anything but previous and next', () => {
		expect(() => clipStepPacket(2 as never)).toThrow(RangeError);
	});
});

describe('entering and leaving playback (record recipes)', () => {
	it('mode only: play and back to preview', () => {
		expect(toHex(buildRecordPacket('B', TransportMode.play, [0, 0, 16, 0, 1, 3]).bytes)).toBe('ff0500000a01010001000000');
		expect(toHex(buildRecordPacket('B', TransportMode.preview, PLAYING).bytes)).toBe('ff0500000a01010000000000');
	});

	it('full echo keeps speed, flags and slots', () => {
		expect(toHex(buildRecordPacket('A', TransportMode.play, [0, 0, 16, 0, 1, 3]).bytes)).toBe('ff0a00000a0101000100100001030000');
		expect(toHex(buildRecordPacket('A', TransportMode.preview, PLAYING).bytes)).toBe('ff0a00000a0101000001100001030000');
	});
});

describe('10.1 speed and flags', () => {
	it('play and pause change only the speed', () => {
		expect(toHex(buildTransportPacket(PAUSED, { mode: TransportMode.play, speed: PlaybackSpeed.play }))).toBe(
			'ff0a00000a0101000101100001030000'
		);
		expect(toHex(buildTransportPacket(PLAYING, { mode: TransportMode.play, speed: PlaybackSpeed.pause }))).toBe(
			'ff0a00000a0101000100100001030000'
		);
	});

	it('carries backwards and fast speeds as signed int8', () => {
		expect(decodePacket(buildTransportPacket(PAUSED, { mode: TransportMode.play, speed: -2 })).values).toEqual([1, -2, 16, 0, 1, 3]);
		expect(decodePacket(buildTransportPacket(PAUSED, { mode: TransportMode.play, speed: 8 })).values).toEqual([1, 8, 16, 0, 1, 3]);
		expect(() => buildTransportPacket(PAUSED, { mode: TransportMode.play, speed: 200 })).toThrow(RangeError);
		expect(() => buildTransportPacket(PAUSED, { mode: TransportMode.play, speed: 0.5 })).toThrow(RangeError);
	});

	it('sets and clears loop / play all, keeping the other bits', () => {
		const loopOn = buildTransportPacket(PAUSED, { mode: TransportMode.play, setFlags: TransportFlag.loop });
		expect(toHex(loopOn)).toBe('ff0a00000a0101000100110001030000');
		const both = [1, 1, 0x10 | 0x01 | 0x02, 0, 1, 3];
		expect(decodePacket(buildTransportPacket(both, { mode: TransportMode.play, clearFlags: TransportFlag.playAll })).values).toEqual([
			1, 1, 0x11, 0, 1, 3
		]);
		// time-lapse bit (signed in reports) survives
		expect(decodePacket(buildTransportPacket([1, 0, -96, 1, 1], { mode: TransportMode.play, setFlags: TransportFlag.loop })).values).toEqual([
			1, 0, -95, 1, 1
		]);
	});

	it('keeps the reported element count (slot count varies by model)', () => {
		expect(decodePacket(buildTransportPacket([1, 0, 0x20, 1, 1], { mode: TransportMode.play, speed: 1 })).values).toEqual([1, 1, 0x20, 1, 1]);
	});

	it('refuses to guess without a report', () => {
		expect(() => buildTransportPacket(null, { mode: TransportMode.play, speed: 1 })).toThrow(RangeError);
		expect(() => buildTransportPacket([1], { mode: TransportMode.play, speed: 1 })).toThrow(RangeError);
		expect(() => buildTransportPacket(PAUSED, { mode: 3 as never })).toThrow(RangeError);
	});

	it('does not mutate the caller state', () => {
		const s = [...PLAYING];
		buildTransportPacket(s, { mode: TransportMode.play, speed: 0, setFlags: 1 });
		expect(s).toEqual(PLAYING);
	});
});
