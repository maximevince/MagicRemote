import { afterEach, describe, expect, it, vi } from 'vitest';
import {
	GattQueue,
	QueueFlushedError,
	QueueStalledError,
	QueueTimeoutError,
	type QueueTask,
	type RunContext
} from './gatt-queue.ts';

/** A fake GATT operation the test completes by hand. */
interface Op {
	label: string;
	ctx: RunContext;
	resolve: (v?: unknown) => void;
	reject: (e: unknown) => void;
}

function harness(options?: ConstructorParameters<typeof GattQueue>[0]) {
	const queue = new GattQueue(options);
	const started: Op[] = [];
	let active = 0;
	let maxActive = 0;
	const task = (label: string, extra: Partial<QueueTask<unknown>> = {}): QueueTask<unknown> => ({
		label,
		...extra,
		run: (ctx) =>
			new Promise((resolve, reject) => {
				active++;
				maxActive = Math.max(maxActive, active);
				const done = <T>(f: (v: T) => void) => (v: T) => {
					active--;
					f(v);
				};
				started.push({ label, ctx, resolve: done(resolve), reject: done(reject) });
			})
	});
	const labels = () => started.map((o) => o.label);
	const last = () => started[started.length - 1];
	return { queue, task, started, labels, last, maxActive: () => maxActive };
}

const tick = () => new Promise((r) => setTimeout(r, 0));

afterEach(() => {
	vi.useRealTimers();
});

describe('GattQueue ordering', () => {
	it('runs one operation at a time, in order', async () => {
		const h = harness();
		const results = ['a', 'b', 'c'].map((l) => h.queue.push(h.task(l)));
		expect(h.labels()).toEqual(['a']);
		expect(h.queue.pending).toBe(2);
		for (let i = 0; i < 3; i++) {
			h.last().resolve(h.last().label.toUpperCase());
			await tick();
		}
		expect(h.labels()).toEqual(['a', 'b', 'c']);
		await expect(Promise.all(results)).resolves.toEqual(['A', 'B', 'C']);
		expect(h.maxActive()).toBe(1);
		expect(h.queue.busy).toBe(false);
	});

	it('serves the urgent lane first but never preempts the operation in flight', async () => {
		const h = harness();
		h.queue.push(h.task('focus1'));
		h.queue.push(h.task('iso'));
		h.queue.push(h.task('rec', { lane: 'urgent' }));
		h.queue.push(h.task('wb'));
		h.queue.push(h.task('stop', { lane: 'urgent' }));
		expect(h.labels()).toEqual(['focus1']);
		for (let i = 0; i < 5; i++) {
			h.last().resolve();
			await tick();
		}
		expect(h.labels()).toEqual(['focus1', 'rec', 'stop', 'iso', 'wb']);
	});

	it('passes an error to its caller and carries on', async () => {
		const h = harness();
		const a = h.queue.push(h.task('a'));
		const b = h.queue.push(h.task('b'));
		h.last().reject(new Error('GATT error'));
		await expect(a).rejects.toThrow('GATT error');
		expect(h.labels()).toEqual(['a', 'b']);
		h.last().resolve(1);
		await expect(b).resolves.toBe(1);
	});

	it('survives a task that throws synchronously', async () => {
		const h = harness();
		const bad = h.queue.push({
			run: () => {
				throw new Error('sync');
			}
		});
		const good = h.queue.push(h.task('good'));
		await expect(bad).rejects.toThrow('sync');
		await tick();
		h.last().resolve('ok');
		await expect(good).resolves.toBe('ok');
	});
});

describe('GattQueue coalescing', () => {
	it('replaces a queued absolute write for the same parameter, keeping its place', async () => {
		const h = harness();
		h.queue.push(h.task('busy'));
		const f1 = h.queue.push(h.task('focus=0.1', { coalesce: { key: '0.0', mode: 'replace' } }));
		h.queue.push(h.task('iso=800', { coalesce: { key: '1.14', mode: 'replace' } }));
		const f2 = h.queue.push(h.task('focus=0.2', { coalesce: { key: '0.0', mode: 'replace' } }));
		const f3 = h.queue.push(h.task('focus=0.3', { coalesce: { key: '0.0', mode: 'replace' } }));
		expect(h.queue.pending).toBe(2);
		for (let i = 0; i < 3; i++) {
			h.last().resolve(h.last().label);
			await tick();
		}
		expect(h.labels()).toEqual(['busy', 'focus=0.3', 'iso=800']);
		// Everyone whose write was merged learns the outcome of the write that went out.
		await expect(Promise.all([f1, f2, f3])).resolves.toEqual(['focus=0.3', 'focus=0.3', 'focus=0.3']);
	});

	it('does not touch a write that is already in flight', async () => {
		const h = harness();
		h.queue.push(h.task('iris=1', { coalesce: { key: '0.2', mode: 'replace' } }));
		h.queue.push(h.task('iris=2', { coalesce: { key: '0.2', mode: 'replace' } }));
		h.last().resolve();
		await tick();
		h.last().resolve();
		await tick();
		expect(h.labels()).toEqual(['iris=1', 'iris=2']);
	});

	it('accumulates offsets instead of replacing them', async () => {
		const h = harness();
		h.queue.push(h.task('busy'));
		const a = h.queue.push(h.task('focus+1', { coalesce: { key: '0.0', mode: 'accumulate', deltas: [1] } }));
		const b = h.queue.push(h.task('focus+1', { coalesce: { key: '0.0', mode: 'accumulate', deltas: [1] } }));
		const c = h.queue.push(h.task('focus-0.5', { coalesce: { key: '0.0', mode: 'accumulate', deltas: [-0.5] } }));
		expect(h.queue.pending).toBe(1);
		h.last().resolve();
		await tick();
		expect(h.last().ctx.deltas).toEqual([1.5]);
		h.last().resolve('sent');
		await expect(Promise.all([a, b, c])).resolves.toEqual(['sent', 'sent', 'sent']);
	});

	it('never folds an offset across an absolute assign of the same parameter', async () => {
		const h = harness();
		h.queue.push(h.task('busy'));
		h.queue.push(h.task('+1', { coalesce: { key: 'k', mode: 'accumulate', deltas: [1] } }));
		h.queue.push(h.task('=5', { coalesce: { key: 'k', mode: 'replace' } }));
		h.queue.push(h.task('+2', { coalesce: { key: 'k', mode: 'accumulate', deltas: [2] } }));
		h.queue.push(h.task('=7', { coalesce: { key: 'k', mode: 'replace' } }));
		expect(h.queue.pending).toBe(4);
		for (let i = 0; i < 5; i++) {
			h.last().resolve();
			await tick();
		}
		expect(h.labels()).toEqual(['busy', '+1', '=5', '+2', '=7']);
		expect(h.started[1].ctx.deltas).toEqual([1]);
		expect(h.started[3].ctx.deltas).toEqual([2]);
	});

	it('never coalesces record commands or tasks without a key', async () => {
		const h = harness();
		h.queue.push(h.task('busy'));
		h.queue.push(h.task('rec', { lane: 'urgent', coalesce: { key: '10.1', mode: 'replace' } }));
		h.queue.push(h.task('rec', { lane: 'urgent', coalesce: { key: '10.1', mode: 'replace' } }));
		h.queue.push(h.task('af'));
		h.queue.push(h.task('af'));
		expect(h.queue.pending).toBe(4);
		for (let i = 0; i < 5; i++) {
			h.last().resolve();
			await tick();
		}
		expect(h.labels()).toEqual(['busy', 'rec', 'rec', 'af', 'af']);
	});
});

describe('GattQueue timeouts and flushing', () => {
	it('times out, stalls without starting the next operation, and reports it', async () => {
		vi.useFakeTimers();
		const onTimeout = vi.fn();
		const h = harness({ timeoutMs: 3000, onTimeout });
		const a = h.queue.push(h.task('slow'));
		const b = h.queue.push(h.task('next'));
		const aErr = a.catch((e) => e);
		const bErr = b.catch((e) => e);
		await vi.advanceTimersByTimeAsync(2999);
		expect(onTimeout).not.toHaveBeenCalled();
		await vi.advanceTimersByTimeAsync(1);
		expect(await aErr).toBeInstanceOf(QueueTimeoutError);
		expect(onTimeout).toHaveBeenCalledOnce();
		expect(h.queue.stalled).toBe(true);
		// The slow operation may still be on the radio, so nothing else starts, even if it completes late.
		h.started[0].resolve('late');
		await vi.advanceTimersByTimeAsync(10_000);
		expect(h.labels()).toEqual(['slow']);
		await expect(h.queue.push(h.task('more'))).rejects.toBeInstanceOf(QueueStalledError);
		// The owner drops the link; everything pending is rejected.
		h.queue.flush(new Error('link dropped'));
		expect(await bErr).toBeInstanceOf(QueueFlushedError);
		expect(h.queue.stalled).toBe(false);
		// After reconnecting the queue works again.
		const c = h.queue.push(h.task('after'));
		h.last().resolve('ok');
		await expect(c).resolves.toBe('ok');
	});

	it('has no timeout for a task that opts out (pairing)', async () => {
		vi.useFakeTimers();
		const h = harness({ timeoutMs: 3000 });
		const p = h.queue.push(h.task('subscribe status', { timeoutMs: null }));
		await vi.advanceTimersByTimeAsync(60_000);
		expect(h.queue.stalled).toBe(false);
		h.last().resolve('paired');
		await expect(p).resolves.toBe('paired');
	});

	it('clears the timer when the operation completes in time', async () => {
		vi.useFakeTimers();
		const onTimeout = vi.fn();
		const h = harness({ timeoutMs: 100, onTimeout });
		const p = h.queue.push(h.task('quick'));
		h.last().resolve(1);
		await expect(p).resolves.toBe(1);
		await vi.advanceTimersByTimeAsync(1000);
		expect(onTimeout).not.toHaveBeenCalled();
	});

	it('rejects the in-flight and every queued operation on flush, and replays nothing', async () => {
		const h = harness();
		const inFlight = h.queue.push(h.task('wb'));
		const rec = h.queue.push(h.task('rec', { lane: 'urgent' }));
		const iso = h.queue.push(h.task('iso'));
		h.queue.flush('disconnected');
		await expect(inFlight).rejects.toBeInstanceOf(QueueFlushedError);
		await expect(rec).rejects.toBeInstanceOf(QueueFlushedError);
		await expect(iso).rejects.toMatchObject({ reason: 'disconnected' });
		expect(h.queue.pending).toBe(0);
		// The old operation settling later must not affect the new connection.
		h.started[0].resolve('stale');
		const fresh = h.queue.push(h.task('fresh'));
		await tick();
		expect(h.labels()).toEqual(['wb', 'fresh']);
		h.last().resolve('ok');
		await expect(fresh).resolves.toBe('ok');
	});
});
