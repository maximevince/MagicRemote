import { describe, expect, it } from 'vitest';
import {
	blockText,
	formatAngle,
	formatAperture,
	formatCodec,
	formatDynamicRange,
	formatFps,
	formatGain,
	formatRecordingFormat,
	formatSpeed,
	formatWhiteBalance
} from './control-format.ts';

describe('control formatting', () => {
	it('formats shutter angles and speeds', () => {
		expect(formatAngle(18000)).toBe('180°');
		expect(formatAngle(17280)).toBe('172.8°');
		expect(formatAngle(1125)).toBe('11.25°');
		expect(formatAngle(4321)).toBe('43.21°');
		expect(formatSpeed(50)).toBe('1/50');
	});

	it('formats gain with a sign', () => {
		expect(formatGain(6)).toBe('+6 dB');
		expect(formatGain(0)).toBe('0 dB');
		expect(formatGain(-12)).toBe('-12 dB');
	});

	it('shows marked f-numbers on third stops and rounds in between', () => {
		expect(formatAperture(4)).toBe('f/4');
		expect(formatAperture(5)).toBe('f/5.6');
		expect(formatAperture(13 / 3)).toBe('f/4.5');
		expect(formatAperture(6)).toBe('f/8');
		expect(formatAperture(7)).toBe('f/11');
		expect(formatAperture(3)).toBe('f/2.8');
		// The captured burst value
		expect(formatAperture(4.1709)).toBe('f/4.2');
		expect(formatAperture(12.5)).toBe('f/76');
		expect(formatAperture(4, 1)).toBe('T4');
	});

	it('names the no-lens value', () => {
		expect(formatAperture(-16)).toBe('No lens');
	});

	it('formats white balance', () => {
		expect(formatWhiteBalance([5600, 10])).toBe('5600K +10');
		expect(formatWhiteBalance([3200, -5])).toBe('3200K -5');
		expect(formatWhiteBalance([4500, 0])).toBe('4500K 0');
	});

	it('names codecs, including the captured BRAW Q5', () => {
		expect(formatCodec([3, 1])).toBe('BRAW Q5');
		expect(formatCodec([3, 3])).toBe('BRAW 5:1');
		expect(formatCodec([2, 0])).toBe('ProRes HQ');
		expect(formatCodec([2, 9])).toBe('ProRes (9)');
		expect(formatCodec([9, 1])).toBe('Codec 9/1');
	});

	it('formats the recording format', () => {
		// The captured burst value
		expect(formatRecordingFormat([24, 24, 6144, 3456, 0])).toBe('6K · 24p');
		expect(formatRecordingFormat([24, 24, 3840, 2160, 0x01])).toBe('UHD · 23.98p');
		expect(formatRecordingFormat([24, 60, 4096, 2160, 0x04])).toBe('4K DCI · 24p · 60 off-speed');
		expect(formatRecordingFormat([25, 25, 1234, 567, 0])).toBe('1234×567 · 25p');
		expect(formatRecordingFormat([24, 24, 6144])).toBe('');
	});

	it('applies the M-rate', () => {
		expect(formatFps(30, true)).toBe('29.97');
		expect(formatFps(60, true)).toBe('59.94');
		expect(formatFps(25, false)).toBe('25');
	});

	it('names dynamic range modes', () => {
		expect(formatDynamicRange(0)).toBe('Film');
		expect(formatDynamicRange(2)).toBe('Extended video');
		expect(formatDynamicRange(7)).toBe('Range 7');
	});

	it('has a reason text for every block', () => {
		expect(blockText('no-lens')).toBe('No lens');
		expect(blockText('syncing')).toBe('Reading camera');
		expect(blockText('gain-mode')).toBe('Camera in gain mode');
	});
});
