import { encode } from './codec.ts';
import { lookup, type ParamDef } from './registry.ts';
import type { Operation, Values } from './types.ts';

/**
 * Outgoing packets for the camera controls (exposure, white balance, lens). Pure builders: each
 * returns the padded bytes for one write. Types and operations come from the registry, so a
 * builder can never disagree with what the decoder accepts.
 */

function def(group: number, param: number): ParamDef {
	const d = lookup(group, param);
	if (!d) throw new Error(`parameter ${group}.${param} is not in the registry`);
	return d;
}

function packet(group: number, param: number, op: Operation, values: Values): Uint8Array {
	const d = def(group, param);
	return encode({ group, param, type: d.type, op, values });
}

/** Fixed16 cannot hold 16.0; keep writes inside what it can carry. */
const FIXED16_TOP = 15.99;

const int = (v: number, what: string): number => {
	if (!Number.isFinite(v)) throw new RangeError(`${what} is not a number: ${v}`);
	return Math.round(v);
};

/** 1.14 ISO, assign. */
export const isoPacket = (iso: number): Uint8Array => packet(1, 14, 'assign', [int(iso, 'ISO')]);

/** 1.13 gain in dB, assign. */
export const gainPacket = (db: number): Uint8Array => packet(1, 13, 'assign', [int(db, 'gain')]);

/** 1.11 shutter angle, assign. `hundredths` is degrees × 100 (180° = 18000). */
export const shutterAnglePacket = (hundredths: number): Uint8Array =>
	packet(1, 11, 'assign', [int(hundredths, 'shutter angle')]);

/** 1.12 shutter speed, assign. `denominator` is x in 1/x s. */
export const shutterSpeedPacket = (denominator: number): Uint8Array =>
	packet(1, 12, 'assign', [int(denominator, 'shutter speed')]);

/** 0.2 aperture as AV (f = 2^(AV/2)), assign. Only the value element is sent, never the units. */
export const aperturePacket = (av: number): Uint8Array =>
	packet(0, 2, 'assign', [Math.min(FIXED16_TOP, Math.max(-1, av))]);

/** 0.5 instantaneous auto aperture: a trigger, no data. */
export const autoAperturePacket = (): Uint8Array => packet(0, 5, 'assign', []);

/** 1.2 manual white balance [Kelvin, tint], assign. Both elements always go together. */
export const whiteBalancePacket = (kelvin: number, tint: number): Uint8Array =>
	packet(1, 2, 'assign', [int(kelvin, 'Kelvin'), int(tint, 'tint')]);

/** 1.3 set auto white balance: a trigger, no data. */
export const autoWhiteBalancePacket = (): Uint8Array => packet(1, 3, 'assign', []);

/** 0.1 instantaneous autofocus: a trigger, no data. */
export const autoFocusPacket = (): Uint8Array => packet(0, 1, 'assign', []);

/**
 * 0.0 focus as an offset (relative-focus lenses such as EF on the Pocket 6K G2).
 * Positive moves towards far. Clamped to one full travel per write.
 */
export const focusOffsetPacket = (delta: number): Uint8Array =>
	packet(0, 0, 'offset', [Math.min(1, Math.max(-1, delta))]);
