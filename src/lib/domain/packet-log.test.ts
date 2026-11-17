import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { fromHex } from '../protocol/index.ts';
import { Param } from './camera-state.svelte.ts';
import { PacketLog } from './packet-log.svelte.ts';

const FIXTURE = fileURLToPath(new URL('../../../fixtures/pocket6kg2-cap1-pair-burst.jsonl', import.meta.url));
const records = readFileSync(FIXTURE, 'utf8')
	.split('\n')
	.filter((l) => l.trim())
	.map((l) => JSON.parse(l) as Record<string, unknown>);

afterEach(() => {
	vi.useRealTimers();
});

describe('PacketLog', () => {
	it('logs notifications in exactly the record shape of the M0 fixtures', () => {
		const log = new PacketLog();
		const ins = records.filter((r) => r.kind === 'in');
		for (const r of ins) {
			const bytes = fromHex(r.hex as string);
			if (r.ch === 'incoming') log.incoming(bytes);
			else if (r.ch === 'timecode') log.timecode(bytes);
			else log.status(bytes);
		}
		const logged = log.records;
		expect(logged).toHaveLength(ins.length);
		logged.forEach((rec, i) => {
			const { t: _a, ...ours } = rec;
			const { t: _b, ...theirs } = ins[i];
			expect(ours).toEqual(theirs);
		});
	});

	it('keeps a rolling window and exports one JSON record per line', () => {
		const log = new PacketLog({ capacity: 3 });
		for (let i = 0; i < 5; i++) log.add('session', { msg: String(i) });
		expect(log.records.map((r) => r.msg)).toEqual(['2', '3', '4']);
		const lines = log.toJsonl().trim().split('\n');
		expect(lines).toHaveLength(3);
		expect(JSON.parse(lines[0])).toMatchObject({ kind: 'session', msg: '2' });
	});
});

describe('Param (confirmed vs expected)', () => {
	it('shows the expected value until the quiet period after the ack, then the confirmed one', () => {
		vi.useFakeTimers();
		const p = new Param<number>();
		p.report(400, 0);
		p.expect(800);
		expect(p.value).toBe(800);
		expect(p.status).toBe('pending');
		p.report(640, 1);
		expect(p.value).toBe(800);
		p.release(300);
		vi.advanceTimersByTime(299);
		expect(p.value).toBe(800);
		vi.advanceTimersByTime(1);
		expect(p.value).toBe(640);
		expect(p.status).toBe('confirmed');
		p.invalidate();
		expect(p.status).toBe('unknown');
		expect(p.fresh).toBe(false);
	});
});
