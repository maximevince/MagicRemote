import { LinkError, type CameraLink, type CharacteristicId, type Unsubscribe } from '../lib/transport/link.ts';
import { encode, toHex } from '../lib/protocol/codec.ts';

/**
 * Minimal in-memory CameraLink for domain tests. Not a camera simulator: it records what the
 * session does and lets the test decide every outcome and every notification. Two camera habits
 * are built in because the session depends on them: a Camera Status 0x01 write makes it resend
 * `powerOnBurst`, and (with `recordBehaviour: 'camera'`) a 10.1 write is echoed by 10.1 only
 * when the transport state (mode, and with `speed`/`flags` set also speed and flags) changes.
 * 10.2 clip steps are never reported; they are counted in `clipSteps`.
 */

export interface TimedNotification {
	/** ms after the Camera Status 0x01 write */
	at: number;
	ch: CharacteristicId;
	bytes: Uint8Array;
}

/** 'ok', an error to throw, or a promise to wait for first (resolve = ok, reject = throw). */
export type Outcome = 'ok' | Error | Promise<void>;

async function play(o: Outcome | undefined): Promise<void> {
	if (o === undefined || o === 'ok') return;
	if (o instanceof Error) throw o;
	await o;
}

export function deferred(): { promise: Promise<void>; resolve: () => void; reject: (e: unknown) => void } {
	let resolve!: () => void;
	let reject!: (e: unknown) => void;
	const promise = new Promise<void>((res, rej) => {
		resolve = res;
		reject = rej;
	});
	return { promise, resolve, reject };
}

export class FakeLink implements CameraLink {
	readonly id = 'fake-device';
	name: string | undefined;
	connected = false;

	/** Every call, in order: "connect", "read model", "write outgoing ff05…", "subscribe status", … */
	readonly ops: string[] = [];
	readonly writes: { ch: CharacteristicId; data: Uint8Array }[] = [];
	reads: Partial<Record<CharacteristicId, Uint8Array>> = {};
	/** Outcomes consumed one per call; an empty plan means 'ok'. */
	connectPlan: Outcome[] = [];
	readPlan: Outcome[] = [];
	writePlan: Partial<Record<CharacteristicId, Outcome[]>> = {};
	subscribePlan: Partial<Record<CharacteristicId, Outcome[]>> = {};
	/** Called after every successful write, e.g. to schedule an echo. */
	onWrite: ((ch: CharacteristicId, data: Uint8Array) => void) | null = null;
	/** Resent after a Camera Status 0x01 write (preceded by Status 0x01). Empty: no reaction. */
	powerOnBurst: readonly TimedNotification[] = [];
	/** The camera's transport mode; the 10.1 reports in `powerOnBurst` carry it. null: as recorded. */
	mode: number | null = null;
	/** The camera's playback speed and 10.1 flags, tracked like `mode` when not null. */
	speed: number | null = null;
	flags: number | null = null;
	/** 'all': a 10.1 write sets every field it carries. 'mode-only': speed and flags in writes are ignored. */
	transportFields: 'all' | 'mode-only' = 'all';
	/** 10.2 values received, in order (0 previous, 1 next). */
	readonly clipSteps: number[] = [];
	/**
	 * 'manual': record writes are only acked (tests use `onWrite`). 'camera': the mode follows the
	 * write and 10.1 is echoed only on a change. 'ignore': acked, mode unchanged, no echo.
	 */
	recordBehaviour: 'manual' | 'camera' | 'ignore' = 'manual';
	echoDelayMs = 100;
	/** Status 0x01 writes seen. */
	powerOnWrites = 0;

	connectCount = 0;
	inFlight = 0;
	maxInFlight = 0;
	readonly #subs = new Map<CharacteristicId, (b: Uint8Array) => void>();
	readonly #onDown = new Set<() => void>();
	readonly #timers = new Set<ReturnType<typeof setTimeout>>();

	constructor(name = 'A:1A2B3C4D') {
		this.name = name;
	}

	async connect(): Promise<void> {
		this.connectCount++;
		await this.#op('connect', async () => {
			await play(this.connectPlan.shift());
			this.connected = true;
		});
	}

	async disconnect(): Promise<void> {
		this.ops.push('disconnect');
		if (this.connected) this.drop();
	}

	/** The link goes down (camera off, out of range). */
	drop(): void {
		this.connected = false;
		this.#subs.clear();
		for (const t of this.#timers) clearTimeout(t);
		this.#timers.clear();
		for (const l of [...this.#onDown]) l();
	}

	read(ch: CharacteristicId): Promise<Uint8Array> {
		return this.#op(`read ${ch}`, async () => {
			await play(this.readPlan.shift());
			this.#requireConnected();
			const v = this.reads[ch];
			if (!v) throw new LinkError('other', `no value for ${ch}`);
			return v;
		});
	}

	write(ch: CharacteristicId, data: Uint8Array): Promise<void> {
		return this.#op(`write ${ch} ${toHex(data)}`, async () => {
			await play(this.writePlan[ch]?.shift());
			this.#requireConnected();
			this.writes.push({ ch, data: new Uint8Array(data) });
			this.#react(ch, data);
			this.onWrite?.(ch, data);
		});
	}

	subscribe(ch: CharacteristicId, listener: (data: Uint8Array) => void): Promise<() => Promise<void>> {
		return this.#op(`subscribe ${ch}`, async () => {
			await play(this.subscribePlan[ch]?.shift());
			this.#requireConnected();
			this.#subs.set(ch, listener);
			return async () => {
				this.ops.push(`unsubscribe ${ch}`);
				if (this.#subs.get(ch) === listener) this.#subs.delete(ch);
			};
		});
	}

	onDisconnect(listener: () => void): Unsubscribe {
		this.#onDown.add(listener);
		return () => this.#onDown.delete(listener);
	}

	/** Deliver a notification or indication, if subscribed. */
	emit(ch: CharacteristicId, bytes: Uint8Array): boolean {
		const l = this.#subs.get(ch);
		l?.(bytes);
		return !!l;
	}

	subscribed(ch: CharacteristicId): boolean {
		return this.#subs.has(ch);
	}

	outgoing(): Uint8Array[] {
		return this.writes.filter((w) => w.ch === 'outgoing').map((w) => w.data);
	}

	/** A 10.1 report as the camera sends it. */
	static transportReport(mode: number, rest: readonly number[] = [0, 16, 0, 1, 3]): Uint8Array {
		return encode({ group: 10, param: 1, type: 'int8', op: 'status', values: [mode, ...rest] });
	}

	#later(ms: number, fn: () => void): void {
		const t = setTimeout(() => {
			this.#timers.delete(t);
			fn();
		}, ms);
		this.#timers.add(t);
	}

	#react(ch: CharacteristicId, data: Uint8Array): void {
		if (ch === 'status' && data[0] === 0x01) {
			this.powerOnWrites++;
			if (!this.powerOnBurst.length) return;
			this.#later(0, () => this.emit('status', new Uint8Array([0x01])));
			for (const e of this.powerOnBurst) this.#later(e.at, () => this.emit(e.ch, this.#withMode(e.bytes)));
			return;
		}
		if (ch === 'outgoing' && data[4] === 10 && data[5] === 2) {
			this.clipSteps.push(data[8]);
			return;
		}
		const isRecord = ch === 'outgoing' && data[4] === 10 && data[5] === 1;
		if (!isRecord || this.recordBehaviour === 'manual' || this.recordBehaviour === 'ignore') return;
		const count = data[1] - 4;
		const target = data[8];
		let changed = target !== this.mode;
		this.mode = target;
		if (this.transportFields === 'all') {
			const int8 = (b: number) => (b > 127 ? b - 256 : b);
			if (count >= 2 && this.speed !== null && int8(data[9]) !== this.speed) {
				this.speed = int8(data[9]);
				changed = true;
			}
			if (count >= 3 && this.flags !== null && data[10] !== this.flags) {
				this.flags = data[10];
				changed = true;
			}
		}
		if (!changed) return;
		const report = this.#currentReport();
		this.#later(this.echoDelayMs, () => this.emit('incoming', report));
	}

	/** The 10.1 report for the tracked state. */
	#currentReport(): Uint8Array {
		return FakeLink.transportReport(this.mode ?? 0, [this.speed ?? 0, this.flags ?? 16, 0, 1, 3]);
	}

	#withMode(bytes: Uint8Array): Uint8Array {
		if (this.mode === null || bytes[4] !== 10 || bytes[5] !== 1) return bytes;
		const out = new Uint8Array(bytes);
		out[8] = this.mode;
		if (this.speed !== null) out[9] = this.speed & 0xff;
		if (this.flags !== null) out[10] = this.flags;
		return out;
	}

	#requireConnected(): void {
		if (!this.connected) throw new LinkError('disconnected', 'GATT Server is disconnected.');
	}

	async #op<T>(label: string, body: () => Promise<T>): Promise<T> {
		this.ops.push(label);
		this.inFlight++;
		this.maxInFlight = Math.max(this.maxInFlight, this.inFlight);
		try {
			await Promise.resolve();
			return await body();
		} finally {
			this.inFlight--;
		}
	}
}
