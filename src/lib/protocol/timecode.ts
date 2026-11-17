import type { Timecode } from './types.ts';

export const DROP_FRAME_MASK = 0x80000000;

function bcdField(byte: number): number | null {
	const hi = byte >> 4;
	const lo = byte & 0x0f;
	return hi > 9 || lo > 9 ? null : hi * 10 + lo;
}

/** Split a 32-bit BCD timecode word (HHMMSSFF, bit 31 = drop frame). */
export function timecodeFromBcd(bcd: number): Timecode {
	const u = bcd >>> 0;
	return {
		// The hours byte uses only 6 bits; bit 31 is the drop-frame flag and bit 30 is unused.
		hours: bcdField((u >>> 24) & 0x3f),
		minutes: bcdField((u >>> 16) & 0xff),
		seconds: bcdField((u >>> 8) & 0xff),
		frames: bcdField(u & 0xff),
		dropFrame: (u & DROP_FRAME_MASK) !== 0,
		bcd: u
	};
}

function toBcdByte(n: number, max: number): number {
	if (!Number.isInteger(n) || n < 0 || n > max) throw new RangeError(`timecode field out of range: ${n}`);
	return ((Math.floor(n / 10) << 4) | n % 10) & 0xff;
}

export function timecodeToBcd(tc: {
	hours: number;
	minutes: number;
	seconds: number;
	frames: number;
	dropFrame?: boolean;
}): number {
	const word =
		(toBcdByte(tc.hours, 39) << 24) |
		(toBcdByte(tc.minutes, 59) << 16) |
		(toBcdByte(tc.seconds, 59) << 8) |
		toBcdByte(tc.frames, 99);
	return ((tc.dropFrame ? word | DROP_FRAME_MASK : word) >>> 0);
}

/**
 * Decode the Timecode characteristic. Despite the PDF calling it "a 32-bit BCD number", the
 * characteristic carries a 12-byte CCU packet (group 9, param 4, int32) with the BCD word
 * little-endian in bytes 8–11. A bare 4-byte value is accepted too.
 */
export function decodeTimecode(buf: Uint8Array): Timecode | null {
	let off: number;
	if (buf.length >= 12 && buf[4] === 9 && buf[5] === 4) off = 8;
	else if (buf.length === 4) off = 0;
	else return null;
	const view = new DataView(buf.buffer, buf.byteOffset + off, 4);
	return timecodeFromBcd(view.getUint32(0, true));
}

/** `HH:MM:SS:FF`, or `HH;MM;SS;FF` for drop frame. Invalid BCD fields are shown as `--`. */
export function formatTimecode(tc: Timecode): string {
	const sep = tc.dropFrame ? ';' : ':';
	const f = (v: number | null) => (v === null ? '--' : String(v).padStart(2, '0'));
	return [tc.hours, tc.minutes, tc.seconds, tc.frames].map(f).join(sep);
}
