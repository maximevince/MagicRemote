import { paramId } from './codec.ts';
import type { DataType, Values } from './types.ts';

/**
 * Parameter table, limited to what the app uses or displays plus
 * everything the Pocket 6K G2 reported in its initial burst. Legal value lists are per model and
 * live in capabilities, not here. Element counts are lenient where firmware varies.
 */

export type ElementCount = number | { min: number; max: number } | 'variable';

export interface ParamDef {
	group: number;
	param: number;
	key: string;
	name: string;
	type: DataType;
	count: ElementCount;
	/** Inclusive range for every element (first element when `rangeOf` is 0). */
	range?: readonly [number, number];
	/** Index of the element `range` applies to; all elements when omitted. */
	rangeOf?: number;
	units?: string;
	/** Does the camera report the value back after a change? */
	echoed: 'yes' | 'no' | 'unreliable';
	retry: 'safe' | 'never';
	/** The full element array must be rebuilt from current state when sending. */
	compound?: boolean;
	/** Reported by the camera, never written by the app. */
	readOnly?: boolean;
	notes?: string;
}

const P = (d: ParamDef): ParamDef => d;

export const PARAMS: readonly ParamDef[] = [
	// ------------------------------------------------------------ 0 Lens
	P({ group: 0, param: 0, key: 'lens.focus', name: 'Focus', type: 'fixed16', count: 1, range: [0, 1], units: 'normalised (0 near, 1 far)', echoed: 'unreliable', retry: 'safe', notes: 'Absolute focus; offsets for relative-focus lenses (EF on the 6K G2)' }),
	P({ group: 0, param: 1, key: 'lens.autoFocus', name: 'Instantaneous autofocus', type: 'void', count: 0, echoed: 'no', retry: 'never', notes: 'Trigger. The 6K G2 also reports it once (empty) in the initial burst' }),
	P({ group: 0, param: 2, key: 'lens.apertureFstop', name: 'Aperture (f-stop)', type: 'fixed16', count: { min: 1, max: 2 }, range: [-16, 16], rangeOf: 0, units: 'AV −1…16 (f = 2^(AV/2)); −16.0 (raw −32768) = no lens', echoed: 'yes', retry: 'safe', notes: 'Reports may carry a 2nd element: units, 0 f-stop / 1 T-stop. The 6K G2 sends it, typed fixed16' }),
	P({ group: 0, param: 3, key: 'lens.apertureNormalised', name: 'Aperture (normalised)', type: 'fixed16', count: 1, range: [0, 1], units: '0 smallest … 1 largest', echoed: 'yes', retry: 'safe' }),
	P({ group: 0, param: 4, key: 'lens.apertureOrdinal', name: 'Aperture (ordinal)', type: 'int16', count: { min: 1, max: 2 }, units: 'step; offsets carry [offset, stepLength]', echoed: 'no', retry: 'never' }),
	P({ group: 0, param: 5, key: 'lens.autoAperture', name: 'Instantaneous auto aperture', type: 'void', count: 0, echoed: 'no', retry: 'never' }),
	P({ group: 0, param: 6, key: 'lens.ois', name: 'Optical image stabilisation', type: 'void', count: { min: 0, max: 1 }, echoed: 'unreliable', retry: 'safe', notes: 'Boolean (void + 1 byte)' }),
	P({ group: 0, param: 7, key: 'lens.zoomMm', name: 'Zoom (mm)', type: 'int16', count: 1, range: [0, 32767], units: 'mm', echoed: 'yes', retry: 'safe' }),
	P({ group: 0, param: 8, key: 'lens.zoomNormalised', name: 'Zoom (normalised)', type: 'fixed16', count: 1, range: [0, 1], units: '0 wide … 1 tele', echoed: 'unreliable', retry: 'safe' }),
	P({ group: 0, param: 9, key: 'lens.zoomSpeed', name: 'Continuous zoom (speed)', type: 'fixed16', count: 1, range: [-1, 1], units: '−1 … +1, 0 stop', echoed: 'no', retry: 'never' }),

	// ------------------------------------------------------------ 1 Video
	P({ group: 1, param: 0, key: 'video.mode', name: 'Video mode', type: 'int8', count: 5, echoed: 'unreliable', retry: 'safe', compound: true, notes: '[fps, M-rate, dimensions, interlaced, colour space]; superseded by 1.9 on cinema cameras' }),
	P({ group: 1, param: 2, key: 'video.whiteBalance', name: 'Manual white balance', type: 'int16', count: 2, units: '[K 2500–10000, tint −50…50]', echoed: 'yes', retry: 'safe', compound: true, notes: 'Per-element ranges checked by checkRange; a corrupted echo after auto WB has been reported' }),
	P({ group: 1, param: 3, key: 'video.autoWhiteBalance', name: 'Set auto white balance', type: 'void', count: 0, echoed: 'no', retry: 'never' }),
	P({ group: 1, param: 4, key: 'video.restoreAutoWhiteBalance', name: 'Restore auto white balance', type: 'void', count: 0, echoed: 'no', retry: 'never' }),
	P({ group: 1, param: 5, key: 'video.exposureUs', name: 'Exposure (µs)', type: 'int32', count: 1, range: [1, 42000], units: 'µs', echoed: 'unreliable', retry: 'safe' }),
	P({ group: 1, param: 6, key: 'video.exposureOrdinal', name: 'Exposure (ordinal)', type: 'int16', count: 1, echoed: 'no', retry: 'safe' }),
	P({ group: 1, param: 7, key: 'video.dynamicRange', name: 'Dynamic range mode', type: 'int8', count: 1, range: [0, 2], units: '0 film, 1 video, 2 extended video', echoed: 'yes', retry: 'safe' }),
	P({ group: 1, param: 8, key: 'video.sharpening', name: 'Video sharpening level', type: 'int8', count: 1, range: [0, 3], units: '0 off, 1 low, 2 medium, 3 high', echoed: 'yes', retry: 'safe' }),
	P({ group: 1, param: 9, key: 'video.recordingFormat', name: 'Recording format', type: 'int16', count: 5, units: '[file fps, sensor fps, width, height, flags]', echoed: 'yes', retry: 'safe', compound: true }),
	P({ group: 1, param: 10, key: 'video.autoExposureMode', name: 'Auto exposure mode', type: 'int8', count: 1, range: [0, 4], units: '0 manual, 1 iris, 2 shutter, 3 iris+shutter, 4 shutter+iris', echoed: 'yes', retry: 'safe' }),
	P({ group: 1, param: 11, key: 'video.shutterAngle', name: 'Shutter angle', type: 'int32', count: 1, range: [100, 36000], units: 'degrees × 100', echoed: 'yes', retry: 'safe', notes: 'The camera reports 1.11 or 1.12 depending on its shutter display setting' }),
	P({ group: 1, param: 12, key: 'video.shutterSpeed', name: 'Shutter speed', type: 'int32', count: 1, range: [1, 5000], units: '1/x s', echoed: 'yes', retry: 'safe' }),
	P({ group: 1, param: 13, key: 'video.gainDb', name: 'Gain', type: 'int8', count: 1, range: [-128, 127], units: 'dB', echoed: 'yes', retry: 'safe', notes: 'Reported instead of 1.14 when the camera is in gain mode' }),
	P({ group: 1, param: 14, key: 'video.iso', name: 'ISO', type: 'int32', count: 1, range: [0, 2147483647], units: 'ISO', echoed: 'yes', retry: 'safe' }),
	P({ group: 1, param: 15, key: 'video.displayLut', name: 'Display LUT', type: 'int8', count: 2, units: '[0 none, 1 custom, 2 film→video, 3 film→ext video; enabled 0/1]', echoed: 'yes', retry: 'safe', compound: true, notes: 'Pocket 6K ignores writes' }),
	P({ group: 1, param: 16, key: 'video.ndStop', name: 'ND filter stop', type: 'fixed16', count: { min: 1, max: 2 }, range: [0, 16], rangeOf: 0, units: 'stops; [1] display mode', echoed: 'yes', retry: 'safe', notes: 'int16 vs fixed16 encoding unverified (open question 6)' }),

	// ------------------------------------------------------------ 3 Output
	P({ group: 3, param: 0, key: 'output.overlayEnables', name: 'Overlay enables', type: 'int16', count: { min: 1, max: 2 }, units: 'bit field [overlays, target displays]', echoed: 'no', retry: 'safe', compound: true, notes: 'The 6K G2 reports one element in the initial burst; not seen echoed after a change' }),
	P({ group: 3, param: 3, key: 'output.overlays', name: 'Overlays', type: 'int8', count: 4, units: '[style, opacity %, safe area %, grid bits]', echoed: 'unreliable', retry: 'safe', compound: true }),

	// ------------------------------------------------------------ 4 Display
	P({ group: 4, param: 1, key: 'display.exposureTools', name: 'Exposure and focus tools', type: 'int16', count: { min: 1, max: 2 }, units: 'bit field [tools, targets]', echoed: 'no', retry: 'safe', compound: true }),
	P({ group: 4, param: 7, key: 'display.timecodeSource', name: 'Timecode source', type: 'int8', count: 1, range: [0, 1], units: '0 clip, 1 timecode', echoed: 'yes', retry: 'safe' }),

	// ------------------------------------------------------------ 7 Configuration
	P({ group: 7, param: 0, key: 'config.realTimeClock', name: 'Real time clock', type: 'int32', count: 2, units: '[BCD HHMMSSFF UTC, BCD YYYYMMDD]', echoed: 'unreliable', retry: 'never', compound: true }),
	P({ group: 7, param: 2, key: 'config.timezone', name: 'Timezone', type: 'int32', count: 1, units: 'minutes from UTC', echoed: 'unreliable', retry: 'safe' }),

	// ------------------------------------------------------------ 9 Status (reports only)
	P({ group: 9, param: 0, key: 'status.battery', name: 'Battery', type: 'int16', count: 3, units: '[mV, %, flags]', echoed: 'yes', retry: 'never', readOnly: true, notes: 'Reported about every second' }),
	P({ group: 9, param: 1, key: 'status.media', name: 'Media status', type: 'int8', count: 'variable', range: [-2, 1], units: 'per slot: 0 none, 1 ready, −1 mount error, −2 record error', echoed: 'yes', retry: 'never', readOnly: true }),
	P({ group: 9, param: 2, key: 'status.remainingTime', name: 'Remaining record time', type: 'int16', count: 'variable', units: 'per slot: >0 s, <0 −minutes, −32768 more than fits, 0 full/empty', echoed: 'yes', retry: 'never', readOnly: true, notes: 'The 6K G2 sends 4 elements while 9.1 and 10.1 have 3 slots' }),
	P({ group: 9, param: 4, key: 'status.displayTimecode', name: 'Display timecode', type: 'int32', count: 1, units: 'BCD', echoed: 'yes', retry: 'never', readOnly: true, notes: 'Carried by the Timecode characteristic' }),
	P({ group: 9, param: 5, key: 'status.cameraSpec', name: 'Camera spec', type: 'int8', count: 'variable', units: '[?, model enum, ?, ?]', echoed: 'yes', retry: 'never', readOnly: true, notes: 'Model 20 = Pocket 6K G2' }),
	P({ group: 9, param: 6, key: 'status.switcher', name: 'Switcher status', type: 'int8', count: 'variable', units: 'flags 0x01 connected, 0x02 preview, 0x04 program', echoed: 'yes', retry: 'never', readOnly: true, notes: 'The 6K G2 sends 2 elements; the meaning of the 2nd is unknown' }),
	P({ group: 9, param: 7, key: 'status.displayParameters', name: 'Display parameters', type: 'int16', count: 'variable', echoed: 'yes', retry: 'never', readOnly: true, notes: 'Undocumented; the 6K G2 sends 6 int16' }),

	// ------------------------------------------------------------ 10 Media
	P({ group: 10, param: 0, key: 'media.codec', name: 'Codec', type: 'int8', count: 2, units: '[codec, variant]', echoed: 'yes', retry: 'safe', compound: true }),
	P({ group: 10, param: 1, key: 'media.transportMode', name: 'Transport mode', type: 'int8', count: 'variable', units: '[mode 0 preview/1 play/2 record, speed, flags, medium per slot…]', echoed: 'yes', retry: 'never', compound: true, notes: 'Record writes go through transport-recipes.ts and the RecordController' }),
	P({ group: 10, param: 2, key: 'media.playbackControl', name: 'Playback control', type: 'int8', count: 1, range: [0, 1], units: '0 previous clip, 1 next clip', echoed: 'no', retry: 'never' }),
	P({ group: 10, param: 3, key: 'media.stillCapture', name: 'Still capture', type: 'void', count: 0, echoed: 'no', retry: 'never' }),

	// ------------------------------------------------------------ 12 Metadata (undocumented, may change)
	P({ group: 12, param: 0, key: 'meta.reel', name: 'Reel', type: 'int16', count: { min: 1, max: 2 }, range: [0, 999], rangeOf: 0, units: '[reel, editable]', echoed: 'yes', retry: 'safe' }),
	P({ group: 12, param: 1, key: 'meta.sceneTags', name: 'Scene tags', type: 'int8', count: 3, units: '[shot type, 0 ext / 1 int, 0 night / 1 day]', echoed: 'yes', retry: 'safe', compound: true }),
	P({ group: 12, param: 2, key: 'meta.scene', name: 'Scene', type: 'string', count: { min: 0, max: 5 }, units: 'bytes', echoed: 'yes', retry: 'safe' }),
	P({ group: 12, param: 3, key: 'meta.take', name: 'Take', type: 'int8', count: 2, units: '[take 1–99, tag −1 none/0 PU/1 VFX/2 SER]', echoed: 'yes', retry: 'safe', compound: true }),
	P({ group: 12, param: 4, key: 'meta.goodTake', name: 'Good take', type: 'void', count: { min: 0, max: 1 }, echoed: 'yes', retry: 'safe', notes: 'Boolean as void + 1 byte (seen on the 6K G2)' }),
	P({ group: 12, param: 5, key: 'meta.cameraId', name: 'Camera ID', type: 'string', count: { min: 0, max: 1 }, units: 'bytes', echoed: 'yes', retry: 'safe' }),
	P({ group: 12, param: 6, key: 'meta.operator', name: 'Camera operator', type: 'string', count: { min: 0, max: 29 }, units: 'bytes', echoed: 'yes', retry: 'safe' }),
	P({ group: 12, param: 7, key: 'meta.director', name: 'Director', type: 'string', count: { min: 0, max: 29 }, units: 'bytes', echoed: 'yes', retry: 'safe' }),
	P({ group: 12, param: 8, key: 'meta.project', name: 'Project name', type: 'string', count: { min: 0, max: 29 }, units: 'bytes', echoed: 'yes', retry: 'safe' }),
	P({ group: 12, param: 9, key: 'meta.lensType', name: 'Lens type', type: 'string', count: { min: 0, max: 56 }, units: 'bytes', echoed: 'yes', retry: 'safe' }),
	P({ group: 12, param: 10, key: 'meta.lensIris', name: 'Lens iris', type: 'string', count: { min: 0, max: 20 }, units: 'bytes', echoed: 'yes', retry: 'safe' }),
	P({ group: 12, param: 11, key: 'meta.lensFocalLength', name: 'Lens focal length', type: 'string', count: { min: 0, max: 30 }, units: 'bytes', echoed: 'yes', retry: 'safe' }),
	P({ group: 12, param: 12, key: 'meta.lensDistance', name: 'Lens distance', type: 'string', count: { min: 0, max: 50 }, units: 'bytes', echoed: 'yes', retry: 'safe' }),
	P({ group: 12, param: 13, key: 'meta.lensFilter', name: 'Lens filter', type: 'string', count: { min: 0, max: 30 }, units: 'bytes', echoed: 'yes', retry: 'safe' }),
	P({ group: 12, param: 14, key: 'meta.slateMode', name: 'Slate for', type: 'int8', count: 1, range: [0, 1], units: '0 recording (next clip), 1 playback', echoed: 'yes', retry: 'safe' }),
	P({ group: 12, param: 15, key: 'meta.slateTarget', name: 'Slate target', type: 'string', count: 'variable', echoed: 'yes', retry: 'never', readOnly: true })
];

const BY_ID = new Map(PARAMS.map((d) => [paramId(d.group, d.param), d]));
const BY_KEY = new Map(PARAMS.map((d) => [d.key, d]));

export function lookup(group: number, param: number): ParamDef | undefined {
	return BY_ID.get(paramId(group, param));
}

export function byKey(key: string): ParamDef | undefined {
	return BY_KEY.get(key);
}

/** Per-element ranges that differ inside one parameter. */
const ELEMENT_RANGES: Readonly<Record<string, readonly (readonly [number, number])[]>> = {
	'video.whiteBalance': [
		[2500, 10000],
		[-50, 50]
	]
};

/**
 * Check decoded values against the definition. Out-of-range values are to be rejected and
 * logged by the caller, never clamped. Strings are checked against their byte limit.
 */
export function checkValues(def: ParamDef, values: Values): boolean {
	const n = typeof values === 'string' ? new TextEncoder().encode(values).length : values.length;
	const c = def.count;
	if (typeof c === 'number' && n !== c) return false;
	if (typeof c === 'object' && (n < c.min || n > c.max)) return false;
	if (typeof values === 'string') return true;
	const perElement = ELEMENT_RANGES[def.key];
	return values.every((raw, i) => {
		const v = Number(raw);
		const r = perElement ? perElement[i] : def.rangeOf === undefined || def.rangeOf === i ? def.range : undefined;
		return !r || (v >= r[0] && v <= r[1]);
	});
}
