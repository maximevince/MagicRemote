import { describe, expect, it } from 'vitest';
import {
	decodeIndication,
	decodePacket,
	encode,
	fromHex,
	readCString,
	splitIndication,
	toHex
} from './codec.ts';
import type { Packet } from './types.ts';

const hex = (s: string) => fromHex(s);

/** Official example packets: S1 p.105 / S2 p.168. */
const GOLDEN: { name: string; bytes: string; packet: Packet }[] = [
	{
		name: 'trigger instantaneous autofocus on camera 4',
		bytes: '04 04 00 00 00 01 00 00',
		packet: { dest: 4, group: 0, param: 1, type: 'void', op: 'assign', values: [] }
	},
	{
		name: 'turn on OIS on all cameras',
		bytes: 'FF 05 00 00 00 06 00 00 01 00 00 00',
		packet: { dest: 255, group: 0, param: 6, type: 'void', op: 'assign', values: [1] }
	},
	{
		name: 'set exposure to 10 ms on camera 4',
		bytes: '04 08 00 00 01 05 03 00 10 27 00 00',
		packet: { dest: 4, group: 1, param: 5, type: 'int32', op: 'assign', values: [10000] }
	},
	{
		name: 'add 15% to zebra level',
		bytes: '04 06 00 00 04 02 80 01 33 01 00 00',
		packet: { dest: 4, group: 4, param: 2, type: 'fixed16', op: 'offset', values: [0.15] }
	},
	{
		name: 'select 1080p 23.98 on all cameras',
		bytes: 'FF 09 00 00 01 00 01 00 18 01 03 00 00 00 00 00',
		packet: { dest: 255, group: 1, param: 0, type: 'int8', op: 'assign', values: [24, 1, 3, 0, 0] }
	},
	{
		name: 'subtract 0.3 from gamma G and B',
		bytes: '04 0C 00 00 08 01 80 01 00 00 9A FD 9A FD 00 00',
		packet: { dest: 4, group: 8, param: 1, type: 'fixed16', op: 'offset', values: [0, -0.3, -0.3, 0] }
	}
];

describe('official example packets', () => {
	for (const g of GOLDEN) {
		it(`encodes: ${g.name}`, () => {
			expect(toHex(encode(g.packet), ' ')).toBe(g.bytes.toLowerCase());
		});

		it(`decodes: ${g.name}`, () => {
			const d = decodePacket(hex(g.bytes));
			expect(d.dest).toBe(g.packet.dest);
			expect([d.group, d.param, d.type, d.op]).toEqual([g.packet.group, g.packet.param, g.packet.type, g.packet.op]);
			const values = d.values as number[];
			const expected = g.packet.values as number[];
			expect(values).toHaveLength(expected.length);
			// fixed16 quantises to 1/2048
			values.forEach((v, i) => expect(v).toBeCloseTo(expected[i], 3));
		});
	}

	it('encodes the 16-byte lift packet of group 8', () => {
		const bytes = encode({ group: 8, param: 0, type: 'fixed16', op: 'assign', values: [0.5, -0.25, 1, 0] });
		expect(toHex(bytes, ' ')).toBe('ff 0c 00 00 08 00 80 00 00 04 00 fe 00 08 00 00');
	});
});

describe('encode', () => {
	it('pads to a multiple of 4 and leaves padding out of the length byte', () => {
		const b = encode({ group: 12, param: 2, type: 'string', op: 'assign', values: '1' });
		expect(toHex(b)).toBe('ff0500000c02050031000000');
	});

	it('accepts the full 64 bytes and rejects more', () => {
		expect(encode({ group: 12, param: 9, type: 'string', op: 'assign', values: 'x'.repeat(56) })).toHaveLength(64);
		expect(() => encode({ group: 12, param: 9, type: 'string', op: 'assign', values: 'x'.repeat(57) })).toThrow(RangeError);
	});

	it('encodes UTF-8 by bytes, not characters', () => {
		const b = encode({ group: 12, param: 6, type: 'string', op: 'assign', values: 'Zoë' });
		expect(b[1]).toBe(4 + 4);
	});

	it('writes int16 bit fields given as unsigned values', () => {
		expect(toHex(encode({ group: 3, param: 0, type: 'int16', op: 'assign', values: [0xffff] }))).toBe('ff06000003000200ffff0000');
	});

	it('writes int64 as little-endian', () => {
		const b = encode({ group: 7, param: 3, type: 'int64', op: 'assign', values: [0x0102030405060708n] });
		expect(toHex(b.subarray(8, 16))).toBe('0807060504030201');
	});

	it('rejects values outside the type', () => {
		expect(() => encode({ group: 1, param: 7, type: 'int8', op: 'assign', values: [256] })).toThrow(RangeError);
		expect(() => encode({ group: 1, param: 7, type: 'int8', op: 'assign', values: [1.5] })).toThrow(RangeError);
		expect(() => encode({ group: 0, param: 0, type: 'fixed16', op: 'assign', values: [16] })).toThrow(RangeError);
		expect(() => encode({ group: 12, param: 2, type: 'string', op: 'assign', values: [1] })).toThrow(TypeError);
	});
});

describe('decodePacket', () => {
	it('keeps an unknown data type as raw bytes', () => {
		const d = decodePacket(hex('ff 07 00 00 0a 02 ff 02 01 02 03'));
		expect(d.typeId).toBe(255);
		expect(d.type).toBeNull();
		expect(d.values).toBeNull();
		expect(toHex(d.data)).toBe('010203');
		expect(d.op).toBe('status');
	});

	it('keeps an unknown operation', () => {
		const d = decodePacket(hex('ff 05 00 00 01 07 01 80 01'));
		expect(d.opId).toBe(0x80);
		expect(d.op).toBeNull();
		expect(d.values).toEqual([1]);
	});

	it('decodes a boolean sent as void with one data byte', () => {
		const d = decodePacket(hex('ff0500000c04000201'));
		expect(d.type).toBe('void');
		expect(d.values).toEqual([1]);
	});

	it('ignores trailing padding and does not validate byte 3', () => {
		const d = decodePacket(hex('ff0800ff0904030016152407'));
		expect(d.source).toBe(0xff);
		expect(d.values).toEqual([0x07241516]);
		const padded = decodePacket(hex('ff0500000c0205023100 0000'));
		expect(padded.values).toBe('1');
		expect(padded.bytes).toHaveLength(9);
	});

	it('strips NULs at the end of a string value', () => {
		expect(decodePacket(hex('ff0700000c0205024100 00')).values).toBe('A');
	});

	it('decodes int64 as bigint', () => {
		const d = decodePacket(hex('ff0c000007030400 0807060504030201'));
		expect(d.values).toEqual([0x0102030405060708n]);
	});

	it('throws on a buffer that cannot be a packet', () => {
		expect(() => decodePacket(hex('ff0400'))).toThrow(RangeError);
		expect(() => decodePacket(hex('ff0900000a010102'))).toThrow(RangeError);
	});
});

// Packets as the 6K G2 sends them (unpadded): 10.1, a type-255 packet, 3.0.
const T101 = 'ff0a00000a010102000010000103'; // 14 bytes
const T255 = 'ff0700000a02ff02aabbcc'; // 11 bytes, synthetic
const O30 = 'ff060000030002020100'; // 10 bytes
const pad = (h: string) => h + '00'.repeat((4 - ((h.length / 2) % 4)) % 4);

describe('splitIndication', () => {
	const ids = (buf: Uint8Array) => decodeIndication(buf).packets.map((p) => `${p.group}.${p.param}`);

	it('handles a single unpadded packet', () => {
		const r = splitIndication(hex(T101));
		expect(r.packets.map((p) => toHex(p))).toEqual([T101]);
		expect(r.rest).toHaveLength(0);
	});

	it('handles a single padded packet', () => {
		const r = splitIndication(hex(pad(T101)));
		expect(r.packets.map((p) => toHex(p))).toEqual([T101]);
		expect(r.rest).toHaveLength(0);
	});

	it('splits concatenated unpadded packets', () => {
		expect(ids(hex(T101 + T255 + O30))).toEqual(['10.1', '10.2', '3.0']);
	});

	it('splits concatenated padded packets', () => {
		expect(ids(hex(pad(T101) + pad(T255) + pad(O30)))).toEqual(['10.1', '10.2', '3.0']);
	});

	it('splits mixed padded and unpadded packets', () => {
		expect(ids(hex(pad(T101) + T255 + pad(O30)))).toEqual(['10.1', '10.2', '3.0']);
		expect(ids(hex(T101 + pad(T255) + O30))).toEqual(['10.1', '10.2', '3.0']);
	});

	it('never treats non-zero bytes as padding', () => {
		// A is 9 bytes, so a padded reading would skip 3 bytes into B, where "ff 04 00 80 .."
		// would even look like a header. B is addressed to camera 4.
		const a = 'ff0500000c04000201';
		const b = '040800ff04008000' + '00080004';
		const r = decodeIndication(hex(a + b));
		expect(r.rest).toHaveLength(0);
		expect(r.packets.map((p) => `${p.dest}:${p.group}.${p.param}`)).toEqual(['255:12.4', '4:4.0']);
	});

	it('backtracks to the reading under which the whole buffer parses', () => {
		// A (9 bytes) + 3 zero padding bytes + B. The unpadded reading hits the zeros and fails,
		// so the padded one must be taken.
		const a = 'ff0500000c04000201';
		const r = decodeIndication(hex(a + '000000' + O30));
		expect(r.rest).toHaveLength(0);
		expect(r.packets.map((p) => `${p.group}.${p.param}`)).toEqual(['12.4', '3.0']);
	});

	it('treats a short run of trailing zeros as padding', () => {
		const r = decodeIndication(hex('ff0500000c04000201' + '000000'));
		expect(r.packets).toHaveLength(1);
		expect(r.rest).toHaveLength(0);
	});

	it('returns unparseable bytes in rest instead of dropping them', () => {
		const r = decodeIndication(hex(T101 + 'deadbeef01'));
		expect(r.packets).toHaveLength(1);
		expect(toHex(r.rest)).toBe('deadbeef01');
	});

	it('returns everything in rest when nothing parses', () => {
		const r = decodeIndication(hex('0102'));
		expect(r.packets).toHaveLength(0);
		expect(toHex(r.rest)).toBe('0102');
	});

	it('accepts an empty indication', () => {
		const r = decodeIndication(new Uint8Array(0));
		expect(r.packets).toHaveLength(0);
		expect(r.rest).toHaveLength(0);
	});

	it('preserves the type-255 packet among others', () => {
		const r = decodeIndication(hex(T101 + T255 + O30));
		const p = r.packets[1];
		expect(p.typeId).toBe(255);
		expect(p.values).toBeNull();
		expect(toHex(p.data)).toBe('aabbcc');
	});
});

describe('readCString', () => {
	it('strips NUL padding from Model Number and Protocol Version', () => {
		expect(readCString(hex('506f636b65742043696e656d612043616d65726120364b204732000000000000'))).toBe(
			'Pocket Cinema Camera 6K G2'
		);
		expect(readCString(hex('302e312e3000000000000000'))).toBe('0.1.0');
		expect(readCString(hex('426c61636b6d616769632044657369676e'))).toBe('Blackmagic Design');
	});
});
