import type { BlockReason } from '../domain/camera-controls.svelte.ts';
import { avToFNumber, isNoLens } from '../domain/control-values.ts';

/** Display text for camera control values. Pure; whatever the camera reports gets a label. */

export const formatIso = (iso: number): string => `${iso}`;

export const formatGain = (db: number): string => `${db > 0 ? '+' : ''}${db} dB`;

/** 1.11 carries degrees × 100. */
export function formatAngle(hundredths: number): string {
	const deg = hundredths / 100;
	return `${Number.isInteger(deg) ? deg : Number(deg.toFixed(2))}°`;
}

export const formatSpeed = (denominator: number): string => `1/${denominator}`;

/** Marked f-numbers in third stops from AV −1 (f/0.7) to AV 12 (f/64). */
const THIRD_STOPS = [
	'0.7', '0.8', '0.9', '1', '1.1', '1.2', '1.4', '1.6', '1.8', '2', '2.2', '2.5', '2.8', '3.2', '3.5', '4', '4.5',
	'5', '5.6', '6.3', '7.1', '8', '9', '10', '11', '13', '14', '16', '18', '20', '22', '25', '29', '32', '36', '40',
	'45', '51', '57', '64'
];

/**
 * f-number from AV. On a third stop it shows the marked number (AV 5 is f/5.6, not 5.66);
 * between stops, one decimal below f/10 and whole numbers above. `units` 1 means T-stops.
 */
export function formatAperture(av: number, units: number | null = null): string {
	if (isNoLens(av)) return 'No lens';
	const thirds = av * 3;
	const i = Math.round(thirds) + 3;
	let n: string;
	if (Math.abs(thirds - Math.round(thirds)) < 0.05 && i >= 0 && i < THIRD_STOPS.length) {
		n = THIRD_STOPS[i];
	} else {
		const f = avToFNumber(av);
		n = f < 10 ? (Math.round(f * 10) / 10).toFixed(1).replace(/\.0$/, '') : `${Math.round(f)}`;
	}
	return units === 1 ? `T${n}` : `f/${n}`;
}

export const formatKelvin = (k: number): string => `${k}K`;

export const formatTint = (t: number): string => (t > 0 ? `+${t}` : `${t}`);

export function formatWhiteBalance(wb: readonly number[]): string {
	return `${formatKelvin(wb[0])} ${formatTint(wb[1])}`;
}

const CODECS: Record<number, { name: string; variants: Record<number, string> }> = {
	0: { name: 'CinemaDNG', variants: { 0: 'RAW', 1: '3:1', 2: '4:1' } },
	1: { name: 'DNxHD', variants: {} },
	2: { name: 'ProRes', variants: { 0: 'HQ', 1: '422', 2: 'LT', 3: 'Proxy', 4: '444', 5: '444 XQ' } },
	3: {
		name: 'BRAW',
		variants: { 0: 'Q0', 7: 'Q1', 8: 'Q3', 1: 'Q5', 2: '3:1', 3: '5:1', 4: '8:1', 5: '12:1', 6: '18:1' }
	}
};

/** 10.0 [codec, variant]. */
export function formatCodec(v: readonly number[]): string {
	const c = CODECS[v[0]];
	if (!c) return `Codec ${v[0]}${v.length > 1 ? `/${v[1]}` : ''}`;
	if (v.length < 2) return c.name;
	const variant = c.variants[v[1]];
	return variant ? `${c.name} ${variant}` : c.name === 'DNxHD' ? c.name : `${c.name} (${v[1]})`;
}

const RESOLUTIONS: Record<string, string> = {
	'6144x3456': '6K',
	'6144x2560': '6K 2.4:1',
	'5744x3024': '5.7K 17:9',
	'4096x2160': '4K DCI',
	'3840x2160': 'UHD',
	'3728x3104': '3.7K 6:5',
	'2868x1512': '2.8K 17:9',
	'1920x1080': 'HD'
};

export function formatResolution(width: number, height: number): string {
	return RESOLUTIONS[`${width}x${height}`] ?? `${width}×${height}`;
}

/** Frame rate with the M-rate (×1000/1001) applied: 24 → 23.98, 30 → 29.97. */
export function formatFps(fps: number, mRate: boolean): string {
	if (!mRate) return `${fps}`;
	return ((fps * 1000) / 1001).toFixed(2);
}

/** 1.9 [file fps, sensor fps, width, height, flags]: "6K · 24p", "UHD · 23.98p · 60 off-speed". */
export function formatRecordingFormat(f: readonly number[]): string {
	if (f.length < 5) return '';
	const [fileFps, sensorFps, w, h, flags] = f;
	const scan = flags & 0x08 ? 'i' : 'p';
	const parts = [formatResolution(w, h), `${formatFps(fileFps, (flags & 0x01) !== 0)}${scan}`];
	if (flags & 0x04 && sensorFps > 0 && sensorFps !== fileFps) {
		parts.push(`${formatFps(sensorFps, (flags & 0x02) !== 0)} off-speed`);
	}
	if (flags & 0x10) parts.push('windowed');
	return parts.join(' · ');
}

const DYNAMIC_RANGE: Record<number, string> = { 0: 'Film', 1: 'Video', 2: 'Extended video' };

export const formatDynamicRange = (v: number): string => DYNAMIC_RANGE[v] ?? `Range ${v}`;

const BLOCK_TEXT: Record<BlockReason, string> = {
	offline: 'Not connected',
	reconnecting: 'Reconnecting',
	standby: 'Camera in standby',
	syncing: 'Reading camera',
	stale: 'No signal',
	unknown: 'Waiting for camera',
	'no-lens': 'No lens',
	'gain-mode': 'Camera in gain mode'
};

export const blockText = (r: BlockReason): string => BLOCK_TEXT[r];
