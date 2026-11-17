import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { decodeIndication, fromHex, readCString, toHex } from './codec.ts';
import { checkValues, lookup } from './registry.ts';
import { decodeTimecode, formatTimecode } from './timecode.ts';
import type { DecodedPacket } from './types.ts';

/**
 * Replays the first real capture from a Pocket Cinema Camera 6K G2 and compares every incoming
 * record with the reference decode m0.py stored next to the raw bytes.
 */

interface RefPacket {
	id: string;
	type: string;
	op: number;
	values?: number[] | string;
	raw?: string;
}
interface Rec {
	t: number;
	kind: string;
	ch?: string;
	hex?: string;
	len?: number;
	packets?: RefPacket[];
	rest?: string | null;
	tc?: string;
	bits?: string;
	what?: string;
	value?: string;
}

const FIXTURE = fileURLToPath(new URL('../../../fixtures/pocket6kg2-cap1-pair-burst.jsonl', import.meta.url));
const records: Rec[] = readFileSync(FIXTURE, 'utf8')
	.split('\n')
	.filter((l) => l.trim())
	.map((l) => JSON.parse(l) as Rec);

const incoming = records.filter((r) => r.kind === 'in' && r.ch === 'incoming');
const timecode = records.filter((r) => r.kind === 'in' && r.ch === 'timecode');
const status = records.filter((r) => r.kind === 'in' && r.ch === 'status');

function compare(p: DecodedPacket, ref: RefPacket) {
	expect(`${p.group}.${p.param}`).toBe(ref.id);
	expect(p.opId).toBe(ref.op);
	if (ref.raw !== undefined) {
		expect(p.type).toBeNull();
		expect(`t${p.typeId}`).toBe(ref.type);
		expect(toHex(p.data)).toBe(ref.raw);
		return;
	}
	expect(p.type).toBe(ref.type);
	if (typeof ref.values === 'string') {
		expect(p.values).toBe(ref.values);
	} else {
		const values = p.values as number[];
		expect(values).toHaveLength(ref.values!.length);
		// The reference rounds fixed16 to 4 decimals.
		values.forEach((v, i) => expect(v).toBeCloseTo(ref.values![i] as number, 4));
	}
}

describe('fixture replay: pocket6kg2-cap1-pair-burst', () => {
	it('contains the expected records', () => {
		expect(incoming).toHaveLength(56);
		expect(timecode).toHaveLength(279);
		expect(status).toHaveLength(2);
	});

	it('decodes every incoming indication exactly like the reference, dropping nothing', () => {
		let total = 0;
		for (const rec of incoming) {
			const buf = fromHex(rec.hex!);
			expect(buf).toHaveLength(rec.len!);
			const { packets, rest } = decodeIndication(buf);
			expect(toHex(rest)).toBe(rec.rest ?? '');
			expect(packets).toHaveLength(rec.packets!.length);
			packets.forEach((p, i) => compare(p, rec.packets![i]));
			// Every byte of the indication is accounted for.
			expect(packets.reduce((n, p) => n + p.bytes.length, 0) + rest.length).toBe(buf.length);
			total += packets.length;
		}
		expect(total).toBe(56);
	});

	it('sees every packet with operation 2 and unpadded lengths', () => {
		const lengths = new Set<number>();
		for (const rec of incoming) {
			for (const p of decodeIndication(fromHex(rec.hex!)).packets) {
				expect(p.op).toBe('status');
				lengths.add(p.bytes.length);
			}
		}
		expect([...lengths].some((n) => n % 4 !== 0)).toBe(true);
	});

	it('knows every parameter in the capture and finds every reported value in range', () => {
		for (const rec of incoming) {
			for (const p of decodeIndication(fromHex(rec.hex!)).packets) {
				const def = lookup(p.group, p.param);
				expect(def, `${p.group}.${p.param}`).toBeDefined();
				expect(def!.type, `${p.group}.${p.param}`).toBe(p.type);
				expect(checkValues(def!, p.values!), `${p.group}.${p.param} ${JSON.stringify(p.values)}`).toBe(true);
			}
		}
	});

	it('decodes every timecode notification like the reference', () => {
		for (const rec of timecode) {
			const tc = decodeTimecode(fromHex(rec.hex!));
			expect(tc).not.toBeNull();
			expect(formatTimecode(tc!)).toBe(rec.tc);
		}
	});

	it('reads Camera Status 0x03 as power on + ready', () => {
		for (const rec of status) {
			const b = fromHex(rec.hex!)[0];
			expect(b & 0x01).toBe(1);
			expect(b & 0x02).toBe(2);
		}
	});

	it('strips NUL padding from the unencrypted reads', () => {
		for (const rec of records.filter((r) => r.kind === 'read' && r.what !== 'status')) {
			expect(readCString(fromHex(rec.hex!))).toBe(rec.value);
		}
	});
});
