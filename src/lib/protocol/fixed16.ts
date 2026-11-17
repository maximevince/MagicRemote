/** Signed 5.11 fixed point: int16 = round(real × 2048). */

export const FIXED16_SCALE = 2048;
export const FIXED16_MIN = -16;
export const FIXED16_MAX = 32767 / FIXED16_SCALE; // 15.99951171875

/** Raw int16 (or its unsigned 16-bit pattern) to a real number. */
export function toFloat(raw: number): number {
	if (!Number.isInteger(raw) || raw < -32768 || raw > 65535) {
		throw new RangeError(`fixed16 raw value out of range: ${raw}`);
	}
	const signed = raw > 32767 ? raw - 65536 : raw;
	return signed / FIXED16_SCALE;
}

/** Real number to raw signed int16. Throws outside −16.0 … 15.9995 rather than wrapping. */
export function fromFloat(value: number): number {
	if (!Number.isFinite(value)) throw new RangeError(`fixed16 value is not finite: ${value}`);
	const raw = Math.round(value * FIXED16_SCALE);
	if (raw < -32768 || raw > 32767) throw new RangeError(`fixed16 value out of range: ${value}`);
	return raw === 0 ? 0 : raw; // no -0
}
