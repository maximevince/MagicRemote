import { buildRecordPacket, TransportMode, type RecordRecipe } from '../protocol/index.ts';
import type { CameraState } from './camera-state.svelte.ts';

/**
 * Record start/stop. The button shows what the camera reports, never what
 * was requested: it turns red only on a 10.1 report with mode 2.
 */

export interface RecordConfig {
	/** Recipe sent first. Which one the Pocket 6K G2 needs is still open. */
	primary: RecordRecipe;
	/** Recipe sent once if no 10.1 arrives within `confirmMs` of the first ack. */
	retry: RecordRecipe;
	confirmMs: number;
	failMs: number;
	/** Presses are ignored this long after the displayed state flipped. */
	pressGuardMs: number;
}

export const DEFAULT_RECORD_CONFIG: RecordConfig = {
	primary: 'B',
	retry: 'A',
	confirmMs: 2000,
	failMs: 5000,
	pressGuardMs: 300
};

export type RecordDisplay = 'unknown' | 'preview' | 'playback' | 'starting' | 'recording' | 'stopping' | 'error';
export type RecordIntent = 'start' | 'stop';

export type PressResult =
	| { ok: true }
	| { ok: false; reason: 'busy' | 'guard' | 'not-connected' | 'no-media' | 'media-full' };

export interface RecordNotice {
	kind: 'no-media' | 'media-full' | 'media-unknown' | 'interrupted';
	slot?: number;
}

export interface RecordError {
	intent: RecordIntent;
	reason: 'not-confirmed' | 'write-failed';
	/** Transport mode last reported by the camera, if any. */
	lastMode: number | null;
	detail?: string;
}

export interface RecordAlert {
	kind: 'unrequested-stop';
	at: number;
}

export interface RecordDeps {
	state: CameraState;
	/** The link is up and synced, so a write can be sent. */
	connected(): boolean;
	/** Connected and the heartbeat is fresh, so reported values are current. */
	live(): boolean;
	/** Send on the urgent lane; resolves when the write is acknowledged. */
	send(bytes: Uint8Array, label: string): Promise<void>;
	now?: () => number;
	config?: Partial<RecordConfig>;
}

interface PendingOp {
	target: 0 | 2;
	acked: boolean;
	recipes: RecordRecipe[];
	timers: ReturnType<typeof setTimeout>[];
}

export class RecordController {
	readonly config: RecordConfig;
	readonly #deps: RecordDeps;
	readonly #now: () => number;

	// Raw: the timers compare the op by identity, which a deep proxy would break.
	#pending = $state.raw<PendingOp | null>(null);
	error = $state<RecordError | null>(null);
	notice = $state<RecordNotice | null>(null);
	alert = $state<RecordAlert | null>(null);
	/** Recipes sent for the last request, for the debug view. */
	lastRecipes = $state<RecordRecipe[]>([]);

	#lastMode: number | null = null;
	#lastFlipAt = -Infinity;
	#stopRequested = false;

	constructor(deps: RecordDeps) {
		this.#deps = deps;
		this.#now = deps.now ?? Date.now;
		this.config = { ...DEFAULT_RECORD_CONFIG, ...deps.config };
	}

	get display(): RecordDisplay {
		const p = this.#pending;
		if (p) return p.target === TransportMode.record ? 'starting' : 'stopping';
		if (!this.#deps.live()) return 'unknown';
		if (this.error) return 'error';
		const t = this.#deps.state.transport;
		if (!t.fresh) return 'unknown';
		switch (this.#deps.state.transportMode) {
			case TransportMode.record:
				return 'recording';
			case TransportMode.play:
				return 'playback';
			case TransportMode.preview:
				return 'preview';
			default:
				return 'unknown';
		}
	}

	/** In `unknown` the UI offers separate Start and Stop buttons instead of a toggle. */
	get split(): boolean {
		return this.display === 'unknown';
	}

	start(): PressResult {
		const guard = this.#guard();
		if (guard) return guard;
		const refusal = this.#preflight();
		if (refusal) return refusal;
		this.#begin(TransportMode.record);
		return { ok: true };
	}

	/** Never preflighted. */
	stop(): PressResult {
		const guard = this.#guard();
		if (guard) return guard;
		this.notice = null;
		this.#stopRequested = true;
		this.#begin(TransportMode.preview);
		return { ok: true };
	}

	/** Called by the session for every accepted 10.1 report, after CameraState was updated. */
	onTransport(values: readonly number[]): void {
		const mode = values[0];
		const p = this.#pending;
		// Before the first ack the camera cannot have acted on our write yet, so only a report of
		// the requested mode ends the request. After it, any report overrides.
		if (p && (mode === p.target || p.acked)) this.#endPending();
		if (this.error) {
			this.error = null;
			this.#flip();
		}
		const prev = this.#lastMode;
		if (prev === TransportMode.record && mode !== TransportMode.record) {
			if (!this.#stopRequested) this.alert = { kind: 'unrequested-stop', at: this.#now() };
		}
		if (mode !== TransportMode.record) this.#stopRequested = false;
		if (mode !== prev) this.#flip();
		this.#lastMode = mode;
	}

	/** The link dropped: whatever was in flight may or may not have reached the camera. */
	linkLost(): void {
		if (this.#pending) {
			this.#endPending();
			this.notice = { kind: 'interrupted' };
		}
		this.error = null;
	}

	dismissAlert(): void {
		this.alert = null;
	}

	dismissNotice(): void {
		this.notice = null;
	}

	#guard(): PressResult | null {
		if (!this.#deps.connected()) return { ok: false, reason: 'not-connected' };
		if (this.#pending) return { ok: false, reason: 'busy' };
		if (this.#now() - this.#lastFlipAt < this.config.pressGuardMs) return { ok: false, reason: 'guard' };
		return null;
	}

	/** Refuse only on a positive, fresh "no media" reading for the active slot. */
	#preflight(): PressResult | null {
		const s = this.#deps.state;
		const slot = s.transport.fresh ? s.activeSlot : null;
		const media = s.media.fresh ? s.media.confirmed : undefined;
		if (slot === null || !media || media[slot] === undefined) {
			this.notice = { kind: 'media-unknown' };
			return null;
		}
		if (media[slot] !== 1) {
			this.notice = { kind: 'no-media', slot };
			return { ok: false, reason: 'no-media' };
		}
		const remaining = s.remaining.fresh ? s.remaining.confirmed?.[slot] : undefined;
		if (remaining === 0) {
			this.notice = { kind: 'media-full', slot };
			return { ok: false, reason: 'media-full' };
		}
		this.notice = null;
		return null;
	}

	#begin(target: 0 | 2): void {
		this.error = null;
		const op: PendingOp = { target, acked: false, recipes: [], timers: [] };
		this.#pending = op;
		this.lastRecipes = [];
		this.#send(op, this.config.primary, true);
	}

	#send(op: PendingOp, recipe: RecordRecipe, first: boolean): void {
		const { bytes, recipe: used } = buildRecordPacket(recipe, op.target, this.#deps.state.transport.confirmed);
		op.recipes.push(used);
		this.lastRecipes = [...op.recipes];
		const label = `record ${op.target === TransportMode.record ? 'start' : 'stop'} (${used})`;
		this.#deps.send(bytes, label).then(
			() => {
				if (this.#pending !== op || !first) return;
				op.acked = true;
				op.timers.push(
					setTimeout(() => {
						if (this.#pending === op) this.#send(op, this.config.retry, false);
					}, this.config.confirmMs),
					setTimeout(() => {
						if (this.#pending === op) this.#fail(op, 'not-confirmed');
					}, this.config.failMs)
				);
			},
			(e: unknown) => {
				// A failed retry leaves the fail timer of the first write running.
				if (this.#pending === op && first) this.#fail(op, 'write-failed', e instanceof Error ? e.message : String(e));
			}
		);
	}

	#fail(op: PendingOp, reason: RecordError['reason'], detail?: string): void {
		this.#endPending();
		// A stop that may not have happened must not silence the unrequested-stop alert.
		if (op.target === TransportMode.preview) this.#stopRequested = false;
		const s = this.#deps.state;
		this.error = {
			intent: op.target === TransportMode.record ? 'start' : 'stop',
			reason,
			lastMode: s.transport.confirmed ? s.transportMode : null,
			detail
		};
		this.#flip();
	}

	#endPending(): void {
		const p = this.#pending;
		if (!p) return;
		for (const t of p.timers) clearTimeout(t);
		this.#pending = null;
		this.#flip();
	}

	#flip(): void {
		this.#lastFlipAt = this.#now();
	}
}
