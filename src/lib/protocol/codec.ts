import { fromFloat, FIXED16_SCALE } from './fixed16.ts';
import {
	DATA_TYPE_ID,
	ELEMENT_SIZE,
	OPERATION_ID,
	type DataType,
	type DecodedPacket,
	type Operation,
	type Packet,
	type Values
} from './types.ts';

export const HEADER_SIZE = 4;
export const COMMAND_HEADER_SIZE = 4;
export const MAX_PACKET_SIZE = 64;
export const BROADCAST = 255;

const TYPE_BY_ID = new Map<number, DataType>(
	Object.entries(DATA_TYPE_ID).map(([k, v]) => [v, k as DataType])
);
const OP_BY_ID = new Map<number, Operation>(
	Object.entries(OPERATION_ID).map(([k, v]) => [v, k as Operation])
);

const utf8Encoder = new TextEncoder();
const utf8Decoder = new TextDecoder('utf-8');

export const pad4 = (n: number): number => (n + 3) & ~3;

// ---------------------------------------------------------------- encode

function checkInt(v: number, min: number, max: number, type: DataType): number {
	if (!Number.isInteger(v) || v < min || v > max) {
		throw new RangeError(`${type} value out of range: ${v}`);
	}
	return v;
}

function encodeData(type: DataType, values: Values): Uint8Array {
	if (type === 'string') {
		if (typeof values !== 'string') throw new TypeError('string parameter needs a string value');
		return utf8Encoder.encode(values);
	}
	if (typeof values === 'string') throw new TypeError(`${type} parameter needs an array value`);
	const size = ELEMENT_SIZE[type];
	const out = new Uint8Array(values.length * size);
	const view = new DataView(out.buffer);
	values.forEach((raw, i) => {
		const o = i * size;
		if (type === 'int64') {
			view.setBigInt64(o, BigInt(raw), true);
			return;
		}
		if (typeof raw === 'bigint') throw new TypeError(`${type} values must be numbers`);
		// Integer types also accept their unsigned range, because several parameters
		// (3.0, 4.1, 10.1 flags) are bit fields carried in signed types.
		switch (type) {
			case 'void':
				view.setUint8(o, checkInt(raw, 0, 0xff, type));
				break;
			case 'int8':
				view.setUint8(o, checkInt(raw, -0x80, 0xff, type) & 0xff);
				break;
			case 'int16':
				view.setUint16(o, checkInt(raw, -0x8000, 0xffff, type) & 0xffff, true);
				break;
			case 'int32':
				view.setUint32(o, checkInt(raw, -0x80000000, 0xffffffff, type) >>> 0, true);
				break;
			case 'fixed16':
				view.setInt16(o, fromFloat(raw), true);
				break;
		}
	});
	return out;
}

/** Encode one command packet, zero-padded to a multiple of 4. Throws if it exceeds 64 bytes. */
export function encode(p: Packet): Uint8Array {
	const data = encodeData(p.type, p.values);
	const cmdLen = COMMAND_HEADER_SIZE + data.length;
	const size = pad4(HEADER_SIZE + cmdLen);
	if (size > MAX_PACKET_SIZE) {
		throw new RangeError(`packet ${p.group}.${p.param} is ${size} bytes; the limit is ${MAX_PACKET_SIZE}`);
	}
	const out = new Uint8Array(size);
	out.set([p.dest ?? BROADCAST, cmdLen, 0, 0, p.group, p.param, DATA_TYPE_ID[p.type], OPERATION_ID[p.op]]);
	out.set(data, HEADER_SIZE + COMMAND_HEADER_SIZE);
	return out;
}

// ---------------------------------------------------------------- decode

function decodeValues(type: DataType, data: Uint8Array): Values {
	if (type === 'string') return utf8Decoder.decode(data).replace(/\0+$/, '');
	// Booleans arrive as void with one data byte; a true trigger has none.
	if (type === 'void') return Array.from(data);
	const size = ELEMENT_SIZE[type];
	const count = Math.floor(data.length / size);
	const view = new DataView(data.buffer, data.byteOffset, data.length);
	if (type === 'int64') {
		return Array.from({ length: count }, (_, i) => view.getBigInt64(i * size, true));
	}
	const read: (o: number) => number = {
		int8: (o: number) => view.getInt8(o),
		int16: (o: number) => view.getInt16(o, true),
		int32: (o: number) => view.getInt32(o, true),
		fixed16: (o: number) => view.getInt16(o, true) / FIXED16_SCALE
	}[type];
	return Array.from({ length: count }, (_, i) => read(i * size));
}

/**
 * Decode a single packet. `bytes` may carry trailing padding; the length byte decides where
 * the packet ends. Throws on a buffer too short to be a packet.
 */
export function decodePacket(bytes: Uint8Array): DecodedPacket {
	if (bytes.length < HEADER_SIZE + COMMAND_HEADER_SIZE) {
		throw new RangeError(`packet too short: ${bytes.length} bytes`);
	}
	const cmdLen = bytes[1];
	const end = HEADER_SIZE + cmdLen;
	if (cmdLen < COMMAND_HEADER_SIZE || end > bytes.length) {
		throw new RangeError(`bad command length ${cmdLen} for a ${bytes.length}-byte buffer`);
	}
	const typeId = bytes[6];
	const opId = bytes[7];
	const type = TYPE_BY_ID.get(typeId) ?? null;
	const data = bytes.slice(HEADER_SIZE + COMMAND_HEADER_SIZE, end);
	return {
		dest: bytes[0],
		command: bytes[2],
		source: bytes[3],
		group: bytes[4],
		param: bytes[5],
		typeId,
		type,
		opId,
		op: OP_BY_ID.get(opId) ?? null,
		values: type === null ? null : decodeValues(type, data),
		data,
		bytes: bytes.slice(0, end)
	};
}

// ---------------------------------------------------------------- splitting indications

function headerAt(buf: Uint8Array, i: number): number | null {
	if (i + HEADER_SIZE + COMMAND_HEADER_SIZE > buf.length) return null;
	const cmdLen = buf[i + 1];
	if (buf[i + 2] !== 0) return null;
	if (cmdLen < COMMAND_HEADER_SIZE || HEADER_SIZE + cmdLen > MAX_PACKET_SIZE) return null;
	if (i + HEADER_SIZE + cmdLen > buf.length) return null;
	return HEADER_SIZE + cmdLen;
}

function onlyPaddingFrom(buf: Uint8Array, i: number): boolean {
	if (buf.length - i >= 4) return false;
	for (let k = i; k < buf.length; k++) if (buf[k] !== 0) return false;
	return true;
}

interface Parse {
	/** [start, end) of each packet, unpadded. */
	spans: [number, number][];
	/** Where parsing stopped. */
	stop: number;
	clean: boolean;
}

export interface SplitResult {
	packets: Uint8Array[];
	/** Bytes that could not be parsed as packets (empty when the whole buffer parsed). */
	rest: Uint8Array;
}

/**
 * Split an indication into packets. One indication may hold several packets, and each may or
 * may not be padded to 4 bytes (the Pocket 6K G2 sends them unpadded; other sources describe
 * padded and concatenated forms). Both continuations are tried after every packet and the one
 * under which the rest of the buffer parses cleanly wins; this backtracking is memoised per
 * offset, so it stays linear. Unparseable bytes are returned in `rest`, never dropped.
 */
export function splitIndication(buf: Uint8Array): SplitResult {
	const memo = new Map<number, Parse>();

	const parse = (i: number): Parse => {
		const hit = memo.get(i);
		if (hit) return hit;
		let result: Parse;
		if (i === buf.length || onlyPaddingFrom(buf, i)) {
			result = { spans: [], stop: buf.length, clean: true };
		} else {
			const n = headerAt(buf, i);
			if (n === null) {
				result = { spans: [], stop: i, clean: false };
			} else {
				const raw = i + n;
				const padded = i + pad4(n);
				const nexts = [raw];
				// Only zero bytes count as padding; otherwise real bytes could be skipped.
				if (padded !== raw && padded <= buf.length && buf.subarray(raw, padded).every((b) => b === 0)) {
					nexts.push(padded);
				}
				// Prefer a continuation that starts with a broadcast header, then the unpadded one.
				nexts.sort((a, b) => Number(buf[b] === 0xff) - Number(buf[a] === 0xff) || a - b);
				let best: Parse | null = null;
				for (const next of nexts) {
					const tail = parse(next);
					const cand: Parse = {
						spans: [[i, i + n], ...tail.spans],
						stop: tail.stop,
						clean: tail.clean
					};
					if (cand.clean) {
						best = cand;
						break;
					}
					if (!best || cand.stop > best.stop) best = cand;
				}
				result = best!;
			}
		}
		memo.set(i, result);
		return result;
	};

	const r = parse(0);
	return {
		packets: r.spans.map(([a, b]) => buf.slice(a, b)),
		rest: r.clean ? new Uint8Array(0) : buf.slice(r.stop)
	};
}

export interface IndicationResult {
	packets: DecodedPacket[];
	rest: Uint8Array;
}

/** Split and decode an Incoming Camera Control indication. Never throws. */
export function decodeIndication(buf: Uint8Array): IndicationResult {
	const { packets, rest } = splitIndication(buf);
	return { packets: packets.map(decodePacket), rest };
}

// ---------------------------------------------------------------- helpers

/** UTF-8 string up to the first NUL (Model Number and Protocol Version are NUL-padded). */
export function readCString(buf: Uint8Array): string {
	const nul = buf.indexOf(0);
	return utf8Decoder.decode(nul === -1 ? buf : buf.subarray(0, nul));
}

export function paramId(group: number, param: number): string {
	return `${group}.${param}`;
}

export function toHex(bytes: Uint8Array, sep = ''): string {
	return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join(sep);
}

export function fromHex(hex: string): Uint8Array {
	const clean = hex.replace(/[\s:]/g, '');
	if (clean.length % 2 !== 0 || /[^0-9a-f]/i.test(clean)) throw new SyntaxError(`bad hex: ${hex}`);
	const out = new Uint8Array(clean.length / 2);
	for (let i = 0; i < out.length; i++) out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
	return out;
}
