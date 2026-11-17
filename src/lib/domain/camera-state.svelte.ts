import {
	checkValues,
	lookup,
	TransportFlag,
	type DecodedPacket,
	type Timecode
} from '../protocol/index.ts';

/**
 * What the camera has told us. The camera is the only source of truth:
 * `confirmed` holds the last reported value, `expected` what the app asked for while a write is
 * outstanding (plus a quiet period), and the UI shows `expected ?? confirmed`.
 * Only the parameters the M1a slice shows are tracked.
 */

export type ParamStatus = 'confirmed' | 'pending' | 'unconfirmable' | 'unknown';

export const QUIET_PERIOD_MS = 300;

export class Param<T> {
	confirmed = $state<T | undefined>(undefined);
	confirmedAt = $state<number | undefined>(undefined);
	expected = $state<T | undefined>(undefined);
	status = $state<ParamStatus>('unknown');
	#quiet: ReturnType<typeof setTimeout> | null = null;

	get value(): T | undefined {
		return this.expected ?? this.confirmed;
	}

	/** Reported during the current connection. */
	get fresh(): boolean {
		return this.status === 'confirmed' || (this.status === 'pending' && this.confirmedAt !== undefined);
	}

	report(value: T, at: number): void {
		this.confirmed = value;
		this.confirmedAt = at;
		if (this.expected === undefined) this.status = 'confirmed';
	}

	/** A write for this parameter was queued. */
	expect(value: T): void {
		this.#clearQuiet();
		this.expected = value;
		this.status = 'pending';
	}

	/** The last write was acknowledged: keep `expected` for the quiet period, then let `confirmed` win. */
	release(quietMs = QUIET_PERIOD_MS): void {
		this.#clearQuiet();
		this.#quiet = setTimeout(() => {
			this.#quiet = null;
			this.expected = undefined;
			this.status = this.confirmedAt === undefined ? 'unknown' : 'confirmed';
		}, quietMs);
	}

	/** The link dropped: keep the last value for display, but it is no longer the camera's state. */
	invalidate(): void {
		this.#clearQuiet();
		this.expected = undefined;
		this.status = 'unknown';
	}

	#clearQuiet(): void {
		if (this.#quiet !== null) clearTimeout(this.#quiet);
		this.#quiet = null;
	}
}

/** Slot index (0-based) from the 10.1 flags. */
export function activeSlotFromFlags(flags: number): number | null {
	const f = flags & 0xff;
	if (f & TransportFlag.disk1Active) return 0;
	if (f & TransportFlag.disk2Active) return 1;
	if (f & TransportFlag.disk3Active) return 2;
	return null;
}

export type RemainingTime =
	| { kind: 'seconds'; seconds: number }
	| { kind: 'plenty' }
	| { kind: 'none' };

/** 9.2 per slot: > 0 seconds, < 0 minus minutes, −32768 more than fits, 0 full or empty. */
export function decodeRemaining(v: number): RemainingTime {
	if (v === -32768) return { kind: 'plenty' };
	if (v > 0) return { kind: 'seconds', seconds: v };
	if (v < 0) return { kind: 'seconds', seconds: -v * 60 };
	return { kind: 'none' };
}

export interface ApplyResult {
	key?: string;
	/** Known parameter whose type, count or range did not match: ignored, never clamped. */
	rejected?: boolean;
}

export class CameraState {
	model = $state<string | null>(null);
	protocolVersion = $state<string | null>(null);
	/** Raw Camera Status byte (bit0 power, bit1 ready). */
	statusByte = $state<number | null>(null);
	timecode = $state<Timecode | null>(null);

	readonly transport = new Param<number[]>();
	readonly battery = new Param<number[]>();
	readonly media = new Param<number[]>();
	readonly remaining = new Param<number[]>();

	get power(): boolean | null {
		return this.statusByte === null ? null : (this.statusByte & 0x01) !== 0;
	}

	/** Transport mode from the last 10.1 (0 preview, 1 play, 2 record), or null. */
	get transportMode(): number | null {
		return this.transport.confirmed?.[0] ?? null;
	}

	get activeSlot(): number | null {
		const t = this.transport.confirmed;
		return t && t.length >= 3 ? activeSlotFromFlags(t[2]) : null;
	}

	get batteryPercent(): number | null {
		return this.battery.confirmed?.[1] ?? null;
	}

	get activeRemaining(): RemainingTime | null {
		const slot = this.activeSlot;
		const r = this.remaining.confirmed;
		if (slot === null || !r || r[slot] === undefined) return null;
		return decodeRemaining(r[slot]);
	}

	apply(p: DecodedPacket, at: number): ApplyResult {
		const def = lookup(p.group, p.param);
		if (!def) return {};
		if (p.type !== def.type || p.values === null || !checkValues(def, p.values)) return { key: def.key, rejected: true };
		const values = p.values as number[];
		switch (def.key) {
			case 'media.transportMode':
				this.transport.report([...values], at);
				break;
			case 'status.battery':
				this.battery.report([...values], at);
				break;
			case 'status.media':
				this.media.report([...values], at);
				break;
			case 'status.remainingTime':
				this.remaining.report([...values], at);
				break;
		}
		return { key: def.key };
	}

	/** After a link loss: nothing shown is current any more. */
	invalidate(): void {
		this.markStale();
		this.timecode = null;
	}

	/** Reports may have been missed (resync): each parameter is current again once re-reported. */
	markStale(): void {
		for (const p of [this.transport, this.battery, this.media, this.remaining]) p.invalidate();
	}
}
