import { decodeIndication, formatTimecode, decodeTimecode, toHex, type DecodedPacket } from '../protocol/index.ts';

/**
 * Rolling log of everything that crosses the link, in the record shape of the M0 captures
 * (`fixtures/*.jsonl`), so an export from the app can become a test fixture as is.
 * `t` is seconds since the log started.
 */

export interface LogRecord {
	t: number;
	kind: string;
	[field: string]: unknown;
}

export interface PacketSummary {
	id: string;
	type: string;
	op: number;
	values?: (number | string)[] | string;
	raw?: string;
}

export function summarizePacket(p: DecodedPacket): PacketSummary {
	const id = `${p.group}.${p.param}`;
	if (p.type === null || p.values === null) return { id, type: `t${p.typeId}`, op: p.opId, raw: toHex(p.data) };
	const values =
		typeof p.values === 'string'
			? p.values
			: (p.values as (number | bigint)[]).map((v) =>
					typeof v === 'bigint' ? (Number.isSafeInteger(Number(v)) ? Number(v) : v.toString()) : Math.round(v * 1e4) / 1e4
				);
	return { id, type: p.type, op: p.opId, values };
}

const bits = (b: number) => b.toString(2).padStart(8, '0');

export class PacketLog {
	readonly capacity: number;
	#records: LogRecord[] = [];
	#start: number;
	readonly #now: () => number;
	/** Bumped on every change; read it to make a view reactive. */
	version = $state(0);

	constructor(options: { capacity?: number; now?: () => number } = {}) {
		this.capacity = options.capacity ?? 5000;
		this.#now = options.now ?? Date.now;
		this.#start = this.#now();
	}

	add(kind: string, fields: Record<string, unknown> = {}): LogRecord {
		const rec: LogRecord = { t: Math.round(this.#now() - this.#start) / 1000, kind, ...fields };
		this.#records.push(rec);
		if (this.#records.length > this.capacity) this.#records.splice(0, this.#records.length - this.capacity);
		this.version++;
		return rec;
	}

	incoming(bytes: Uint8Array): DecodedPacket[] {
		const { packets, rest } = decodeIndication(bytes);
		this.add('in', {
			ch: 'incoming',
			len: bytes.length,
			hex: toHex(bytes),
			packets: packets.map(summarizePacket),
			rest: rest.length ? toHex(rest) : null
		});
		return packets;
	}

	timecode(bytes: Uint8Array): void {
		const tc = decodeTimecode(bytes);
		this.add('in', { ch: 'timecode', hex: toHex(bytes), tc: tc ? formatTimecode(tc) : null });
	}

	status(bytes: Uint8Array): void {
		this.add('in', { ch: 'status', hex: toHex(bytes), bits: bytes.length ? bits(bytes[0]) : '' });
	}

	outgoing(bytes: Uint8Array, label?: string): void {
		const { packets } = decodeIndication(bytes);
		this.add('out', { ch: 'outgoing', len: bytes.length, hex: toHex(bytes), packets: packets.map(summarizePacket), ...(label ? { what: label } : {}) });
	}

	get records(): readonly LogRecord[] {
		void this.version;
		return this.#records;
	}

	recent(n: number): readonly LogRecord[] {
		void this.version;
		return this.#records.slice(-n);
	}

	clear(): void {
		this.#records = [];
		this.#start = this.#now();
		this.version++;
	}

	/** One JSON record per line, like the fixtures. */
	toJsonl(): string {
		return this.#records.map((r) => JSON.stringify(r)).join('\n') + (this.#records.length ? '\n' : '');
	}
}
