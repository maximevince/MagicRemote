import { LinkError, type CameraLink, type CharacteristicId, type Unsubscribe } from '../lib/transport/link.ts';
import { toHex } from '../lib/protocol/codec.ts';

/**
 * Minimal in-memory CameraLink for domain tests. Not a camera simulator: it records what the
 * session does and lets the test decide every outcome and every notification.
 */

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

	connectCount = 0;
	inFlight = 0;
	maxInFlight = 0;
	readonly #subs = new Map<CharacteristicId, (b: Uint8Array) => void>();
	readonly #onDown = new Set<() => void>();

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
