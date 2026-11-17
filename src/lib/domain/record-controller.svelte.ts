import { buildRecordPacket, TransportMode, type RecordRecipe } from '../protocol/index.ts';
import type { CameraState } from './camera-state.svelte.ts';

/**
 * Record start/stop. The button shows what the camera reports, never what
 * was requested: it turns red only on a 10.1 report with mode 2.
 *
 * The camera sends 10.1 only when the transport mode changes, so an acknowledged write without
 * an echo is ambiguous (ignored, or already in that mode). It is settled by a session resync,
 * whose burst starts with 10.1: the requested mode means done; otherwise the retry recipe is
 * sent once, and if that too ends without the requested mode after a resync, it is an error.
 */

export interface RecordConfig {
	/** Recipe sent first. Which one the Pocket 6K G2 needs is still open. */
	primary: RecordRecipe;
	/** Recipe sent once if the resync after the first write shows another mode. */
	retry: RecordRecipe;
	/** Wait this long after an ack for a 10.1 echo before resyncing. */
	confirmMs: number;
	/** Presses are ignored this long after the displayed state flipped. */
	pressGuardMs: number;
}

export const DEFAULT_RECORD_CONFIG: RecordConfig = {
	primary: 'B',
	retry: 'A',
	confirmMs: 2000,
	pressGuardMs: 300
};

export type RecordDisplay =
	| 'unknown'
	| 'syncing'
	| 'preview'
	| 'playback'
	| 'starting'
	| 'recording'
	| 'stopping'
	| 'error';
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
	/** A session resync is running. */
	syncing(): boolean;
	/**
	 * Session resync; true when the camera resent its state. Joins a running one, or with `after`
	 * runs a new one behind it, so the result reflects the writes sent before the call.
	 */
	resync(after: boolean): Promise<boolean>;
	/** Send on the urgent lane; resolves when the write is acknowledged. */
	send(bytes: Uint8Array, label: string): Promise<void>;
	now?: () => number;
	config?: Partial<RecordConfig>;
}

/**
 * presync: state was unknown at the press, resyncing before acting.
 * sent / retry: write sent, waiting for an echo. resync / final: resyncing to judge.
 */
type Stage = 'presync' | 'sent' | 'resync' | 'retry' | 'final';

interface PendingOp {
	target: 0 | 2;
	stage: Stage;
	acked: boolean;
	recipes: RecordRecipe[];
	timer: ReturnType<typeof setTimeout> | null;
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
		if (!t.fresh) return this.#deps.syncing() ? 'syncing' : 'unknown';
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

	/** With the state unknown, resyncs first and acts on what the camera then reports. */
	start(): PressResult {
		const guard = this.#guard();
		if (guard) return guard;
		if (this.#unsure()) {
			this.#presync(TransportMode.record);
			return { ok: true };
		}
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
		if (this.#unsure()) this.#presync(TransportMode.preview);
		else this.#begin(TransportMode.preview);
		return { ok: true };
	}

	/** Called by the session for every accepted 10.1 report, after CameraState was updated. */
	onTransport(values: readonly number[]): void {
		const mode = values[0];
		if (this.error) {
			this.error = null;
			this.#flip();
		}
		const p = this.#pending;
		// A stop acts on the first 10.1; a start waits for the whole burst so the media check is current.
		if (p?.stage === 'presync') {
			if (p.target === TransportMode.preview || this.#reached(p)) this.#act(p);
		}
		else if (p?.stage === 'resync' || p?.stage === 'final') this.#judge(p);
		// Before the first ack the camera cannot have acted on our write yet, so only a report of
		// the requested mode ends the request. After it, any report overrides.
		else if (p && (mode === p.target || p.acked)) this.#endPending();
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

	/** The display is not a fresh camera report, so the intent cannot be checked against it. */
	#unsure(): boolean {
		const d = this.display;
		return d === 'unknown' || d === 'syncing';
	}

	#newOp(target: 0 | 2, stage: Stage): PendingOp {
		this.error = null;
		const op: PendingOp = { target, stage, acked: false, recipes: [], timer: null };
		this.#pending = op;
		this.lastRecipes = [];
		return op;
	}

	#begin(target: 0 | 2): void {
		this.#send(this.#newOp(target, 'sent'), this.config.primary);
	}

	#presync(target: 0 | 2): void {
		const op = this.#newOp(target, 'presync');
		void this.#deps.resync(false).then(() => {
			if (this.#pending === op && op.stage === 'presync') this.#act(op);
		});
	}

	/** After the presync: done if the camera is already in the requested mode, else send. */
	#act(op: PendingOp): void {
		if (this.#reached(op)) return this.#endPending();
		if (op.target === TransportMode.record && this.#preflight()) return this.#endPending();
		op.stage = 'sent';
		this.#send(op, this.config.primary);
	}

	/** After a resync (or its first 10.1): satisfied, retry once, or give up. */
	#judge(op: PendingOp): void {
		if (this.#reached(op)) return this.#endPending();
		if (op.stage === 'resync') {
			op.stage = 'retry';
			this.#send(op, this.config.retry);
		} else {
			this.#fail(op, 'not-confirmed');
		}
	}

	#reached(op: PendingOp): boolean {
		const s = this.#deps.state;
		return s.transport.fresh && s.transportMode === op.target;
	}

	#send(op: PendingOp, recipe: RecordRecipe): void {
		const stage = op.stage;
		const { bytes, recipe: used } = buildRecordPacket(recipe, op.target, this.#deps.state.transport.confirmed);
		op.recipes.push(used);
		this.lastRecipes = [...op.recipes];
		const label = `record ${op.target === TransportMode.record ? 'start' : 'stop'} (${used})`;
		this.#deps.send(bytes, label).then(
			() => {
				if (this.#pending !== op || op.stage !== stage) return;
				op.acked = true;
				op.timer = setTimeout(() => {
					op.timer = null;
					if (this.#pending === op && op.stage === stage) this.#resyncToJudge(op);
				}, this.config.confirmMs);
			},
			(e: unknown) => {
				if (this.#pending === op && op.stage === stage) this.#fail(op, 'write-failed', e instanceof Error ? e.message : String(e));
			}
		);
	}

	/** Acked but no echo: the camera may have ignored it or already been in that mode. */
	#resyncToJudge(op: PendingOp): void {
		const stage: Stage = op.stage === 'sent' ? 'resync' : 'final';
		op.stage = stage;
		void this.#deps.resync(true).then(() => {
			if (this.#pending === op && op.stage === stage) this.#judge(op);
		});
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
		if (p.timer !== null) clearTimeout(p.timer);
		this.#pending = null;
		this.#flip();
	}

	#flip(): void {
		this.#lastFlipAt = this.#now();
	}
}
