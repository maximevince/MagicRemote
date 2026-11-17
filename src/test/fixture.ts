import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { fromHex } from '../lib/protocol/codec.ts';
import type { CharacteristicId } from '../lib/transport/link.ts';

/** The successful pairing run of the first Pocket 6K G2 capture, ready to replay. */

interface Rec {
	t: number;
	kind: string;
	ch?: string;
	ev?: string;
	what?: string;
	hex?: string;
}

const FIXTURE = fileURLToPath(new URL('../../fixtures/pocket6kg2-cap1-pair-burst.jsonl', import.meta.url));

const all: Rec[] = readFileSync(FIXTURE, 'utf8')
	.split('\n')
	.filter((l) => l.trim())
	.map((l) => JSON.parse(l) as Rec);

// The file holds several runs; each starts with the agent registration. The last one paired.
const start = all.map((r) => r.ev).lastIndexOf('registered');
const run = all.slice(start);

const readHex = (what: string) => fromHex(run.find((r) => r.kind === 'read' && r.what === what)!.hex!);

export const MODEL_BYTES = readHex('model');
export const PROTOCOL_BYTES = readHex('protocol');

export interface ReplayEvent {
	/** ms after the last subscription completed */
	at: number;
	ch: CharacteristicId;
	bytes: Uint8Array;
}

const t0 = run.find((r) => r.kind === 'subscribed' && r.ch === 'timecode')!.t;

/** Every notification after subscribing, in capture order, with capture timing. */
export const BURST: readonly ReplayEvent[] = run
	.filter((r) => r.kind === 'in' && r.t >= t0)
	.map((r) => ({ at: Math.round((r.t - t0) * 1000), ch: r.ch as CharacteristicId, bytes: fromHex(r.hex!) }));

/** Index of the Camera Status ready notification that ends the initial burst. */
export const READY_INDEX = BURST.findIndex((e) => e.ch === 'status');

export const TIMECODE_SAMPLE = BURST.find((e) => e.ch === 'timecode')!.bytes;
