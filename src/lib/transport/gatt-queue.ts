/**
 * One GATT operation in flight per device.
 *
 * - Two lanes: `urgent` (record/stop, power) is served before `normal`. Nothing preempts an
 *   operation already in flight.
 * - Coalescing, normal lane only, against the most recent still-queued task with the same key:
 *   `replace` (absolute assigns) swaps in the newer task; `accumulate` (offsets) adds the deltas
 *   element-wise. Callers whose tasks were merged share the outcome of the write that went out.
 *   Tasks without `coalesce` (record, triggers, power) are never merged.
 * - Tasks build their payload in `run`, i.e. at dequeue time, so compound parameters can be
 *   assembled from the latest state.
 * - No retries. A timed-out operation may still be in flight (Web Bluetooth has no cancel), so
 *   the queue stalls until `flush()` is called, which the session does when it drops the link.
 * - `flush()` rejects everything pending; nothing survives into the next connection.
 */

export type Lane = 'urgent' | 'normal';

export type Coalesce =
	| { key: string; mode: 'replace' }
	| { key: string; mode: 'accumulate'; deltas: readonly number[] };

export interface RunContext {
	/** For `accumulate` tasks: the summed deltas of every merged task. */
	deltas?: readonly number[];
}

export interface QueueTask<T> {
	label?: string;
	lane?: Lane;
	/** Overrides the queue default; `null` disables the timeout (pairing: the user is typing a PIN). */
	timeoutMs?: number | null;
	coalesce?: Coalesce;
	run(ctx: RunContext): Promise<T>;
}

export interface GattQueueOptions {
	/** Default per-operation timeout. */
	timeoutMs?: number;
	/** Called once when an operation times out; the owner should drop and reconnect the link. */
	onTimeout?: (error: QueueTimeoutError) => void;
}

export class QueueTimeoutError extends Error {
	constructor(readonly label: string | undefined, readonly timeoutMs: number) {
		super(`GATT operation${label ? ` "${label}"` : ''} timed out after ${timeoutMs} ms`);
		this.name = 'QueueTimeoutError';
	}
}

export class QueueFlushedError extends Error {
	constructor(readonly reason?: unknown) {
		super('GATT queue flushed', { cause: reason });
		this.name = 'QueueFlushedError';
	}
}

export class QueueStalledError extends Error {
	constructor() {
		super('GATT queue is stalled after a timeout; flush it before queueing more');
		this.name = 'QueueStalledError';
	}
}

interface Waiter {
	resolve: (v: unknown) => void;
	reject: (e: unknown) => void;
}

interface Entry {
	task: QueueTask<unknown>;
	lane: Lane;
	deltas?: number[];
	waiters: Waiter[];
	settled: boolean;
}

export const DEFAULT_TIMEOUT_MS = 3000;

export class GattQueue {
	readonly #timeoutMs: number;
	readonly #onTimeout?: (error: QueueTimeoutError) => void;
	readonly #lanes: Record<Lane, Entry[]> = { urgent: [], normal: [] };
	#inFlight: Entry | null = null;
	#timer: ReturnType<typeof setTimeout> | null = null;
	#stalled = false;
	#generation = 0;

	constructor(options: GattQueueOptions = {}) {
		this.#timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
		this.#onTimeout = options.onTimeout;
	}

	/** Number of queued operations, not counting the one in flight. */
	get pending(): number {
		return this.#lanes.urgent.length + this.#lanes.normal.length;
	}

	get busy(): boolean {
		return this.#inFlight !== null;
	}

	/** True after a timeout, until `flush()`. */
	get stalled(): boolean {
		return this.#stalled;
	}

	push<T>(task: QueueTask<T>): Promise<T> {
		if (this.#stalled) return Promise.reject(new QueueStalledError());
		return new Promise<T>((resolve, reject) => {
			const waiter: Waiter = { resolve: resolve as (v: unknown) => void, reject };
			const lane = task.lane ?? 'normal';
			if (lane === 'normal' && task.coalesce && this.#merge(task as QueueTask<unknown>, waiter)) return;
			const entry: Entry = { task: task as QueueTask<unknown>, lane, waiters: [waiter], settled: false };
			if (task.coalesce?.mode === 'accumulate') entry.deltas = [...task.coalesce.deltas];
			this.#lanes[lane].push(entry);
			this.#pump();
		});
	}

	/** Reject the in-flight and every queued operation, and clear a stall. Call on disconnect. */
	flush(reason?: unknown): void {
		this.#generation++;
		this.#clearTimer();
		const error = new QueueFlushedError(reason);
		const all = [...(this.#inFlight ? [this.#inFlight] : []), ...this.#lanes.urgent, ...this.#lanes.normal];
		this.#inFlight = null;
		this.#lanes.urgent = [];
		this.#lanes.normal = [];
		this.#stalled = false;
		for (const e of all) this.#settle(e, false, error);
	}

	#merge(task: QueueTask<unknown>, waiter: Waiter): boolean {
		const c = task.coalesce!;
		const lane = this.#lanes.normal;
		let last: Entry | undefined;
		for (let i = lane.length - 1; i >= 0; i--) {
			if (lane[i].task.coalesce?.key === c.key) {
				last = lane[i];
				break;
			}
		}
		// Only merge with the latest queued task for this key, and only of the same kind, so an
		// offset is never folded across an absolute assign.
		if (!last || last.task.coalesce?.mode !== c.mode) return false;
		if (c.mode === 'accumulate') {
			if (!last.deltas || last.deltas.length !== c.deltas.length) return false;
			last.deltas = last.deltas.map((d, i) => d + c.deltas[i]);
		}
		last.task = task;
		last.waiters.push(waiter);
		return true;
	}

	#pump(): void {
		if (this.#inFlight || this.#stalled) return;
		const entry = this.#lanes.urgent.shift() ?? this.#lanes.normal.shift();
		if (!entry) return;
		this.#inFlight = entry;
		const generation = this.#generation;

		const timeoutMs = entry.task.timeoutMs === undefined ? this.#timeoutMs : entry.task.timeoutMs;
		if (timeoutMs !== null) {
			this.#timer = setTimeout(() => {
				if (generation !== this.#generation || this.#inFlight !== entry) return;
				this.#timer = null;
				// The operation may still complete on the radio; never start the next one.
				this.#stalled = true;
				const error = new QueueTimeoutError(entry.task.label, timeoutMs);
				this.#settle(entry, false, error);
				this.#onTimeout?.(error);
			}, timeoutMs);
		}

		let result: Promise<unknown>;
		try {
			result = Promise.resolve(entry.task.run(entry.deltas ? { deltas: entry.deltas } : {}));
		} catch (e) {
			result = Promise.reject(e);
		}
		result.then(
			(v) => this.#finish(entry, generation, true, v),
			(e) => this.#finish(entry, generation, false, e)
		);
	}

	#finish(entry: Entry, generation: number, ok: boolean, value: unknown): void {
		if (generation !== this.#generation || this.#inFlight !== entry) return;
		if (this.#stalled) return; // timed out earlier; stays stalled until flush()
		this.#clearTimer();
		this.#inFlight = null;
		this.#settle(entry, ok, value);
		this.#pump();
	}

	#settle(entry: Entry, ok: boolean, value: unknown): void {
		if (entry.settled) return;
		entry.settled = true;
		for (const w of entry.waiters) (ok ? w.resolve : w.reject)(value);
	}

	#clearTimer(): void {
		if (this.#timer !== null) clearTimeout(this.#timer);
		this.#timer = null;
	}
}
