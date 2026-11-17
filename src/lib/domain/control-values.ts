/**
 * Value lists and stepping rules for the camera controls. These are pickers' suggestions, not
 * the camera's legal values: whatever the camera reports is shown even when it is not listed,
 * and the camera clamps or snaps what it receives.
 */

/** Full and third stops, 100–25600 (the Pocket 6K G2 range). */
export const ISO_STOPS: readonly number[] = [
	100, 125, 160, 200, 250, 320, 400, 500, 640, 800, 1000, 1250, 1600, 2000, 2500, 3200, 4000, 5000, 6400, 8000,
	10000, 12800, 16000, 20000, 25600
];

/** Shutter angles in degrees × 100, as 1.11 carries them. */
export const SHUTTER_ANGLES: readonly number[] = [
	1125, 1500, 2250, 3000, 4500, 6000, 7200, 7500, 8640, 9000, 12000, 14400, 15000, 17280, 18000, 21600, 27000,
	32400, 36000
];

/** Shutter speeds as the x in 1/x s, as 1.12 carries them. */
export const SHUTTER_SPEEDS: readonly number[] = [
	24, 25, 30, 48, 50, 60, 96, 100, 120, 125, 160, 200, 250, 320, 500, 1000, 2000
];

export const WB_PRESETS: readonly { kelvin: number; label: string }[] = [
	{ kelvin: 3200, label: 'Tungsten' },
	{ kelvin: 4000, label: 'Fluorescent' },
	{ kelvin: 4500, label: 'Mixed' },
	{ kelvin: 5600, label: 'Daylight' },
	{ kelvin: 6500, label: 'Cloudy' },
	{ kelvin: 7500, label: 'Shade' }
];

export const WB_KELVIN_MIN = 2500;
export const WB_KELVIN_MAX = 10000;
export const WB_KELVIN_STEP = 100;
export const WB_TINT_MIN = -50;
export const WB_TINT_MAX = 50;

/** 0.2 reports −32768 raw (−16.0 as fixed16) when no lens is attached or it has no electronics. */
export const NO_LENS_AV = -16;
export const AV_MIN = -1;
export const AV_MAX = 15.99;

/** Focus offsets per nudge, as fractions of the full travel. */
export const FOCUS_FINE = 0.01;
export const FOCUS_COARSE = 0.1;

export type Direction = -1 | 1;

/**
 * The next listed value from `current` in `dir`. An off-list current value goes to the nearest
 * listed value in that direction. Null at the end of the list (or with no current value).
 */
export function stepInList(list: readonly number[], current: number | undefined, dir: Direction): number | null {
	if (current === undefined || !list.length) return null;
	if (dir > 0) return list.find((v) => v > current) ?? null;
	for (let i = list.length - 1; i >= 0; i--) if (list[i] < current) return list[i];
	return null;
}

/** Speeds that a shutter at `fps` can reach: 1/x s must not be longer than one frame. */
export function speedsFor(fps: number | null): readonly number[] {
	return fps ? SHUTTER_SPEEDS.filter((s) => s >= fps) : SHUTTER_SPEEDS;
}

export const isNoLens = (av: number | undefined): boolean => av !== undefined && av <= NO_LENS_AV;

/** f-number for an AV value: f = 2^(AV/2). */
export const avToFNumber = (av: number): number => Math.pow(2, av / 2);

/**
 * One third of a stop from `av`, snapped to the third-stop grid, so steps land on the marked
 * f-numbers (f/4, f/4.5, f/5 …) even when the lens reported something in between. `dir` +1
 * closes the iris (larger f-number). The tolerance absorbs fixed16 rounding and the lens landing
 * slightly off the mark: asked for 4.333, a Pocket 6K G2 with an EF lens reported 4.340.
 */
export function irisStep(av: number, dir: Direction): number {
	const thirds = av * 3;
	const eps = 0.1;
	const next = dir > 0 ? (Math.floor(thirds + eps) + 1) / 3 : (Math.ceil(thirds - eps) - 1) / 3;
	return Math.min(AV_MAX, Math.max(AV_MIN, next));
}

export function clampKelvin(k: number): number {
	return Math.min(WB_KELVIN_MAX, Math.max(WB_KELVIN_MIN, Math.round(k)));
}

export function clampTint(t: number): number {
	return Math.min(WB_TINT_MAX, Math.max(WB_TINT_MIN, Math.round(t)));
}

/** Kelvin one step from `k`, on the 100 K grid. */
export function kelvinStep(k: number, dir: Direction): number {
	const grid = dir > 0 ? Math.floor(k / WB_KELVIN_STEP + 1e-6) + 1 : Math.ceil(k / WB_KELVIN_STEP - 1e-6) - 1;
	return clampKelvin(grid * WB_KELVIN_STEP);
}
