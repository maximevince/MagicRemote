import {
	buildRecordPacket,
	buildTransportPacket,
	ClipStep,
	clipStepPacket,
	PlaybackSpeed,
	TransportFlag,
	TransportMode,
	type ClipStepValue,
	type RecordRecipe
} from '../protocol/index.ts';
import type { CameraState } from './camera-state.svelte.ts';
import type { RecordDisplay } from './record-controller.svelte.ts';

/**
 * Clip playback: enter and leave playback, play / pause, loop and play-all, previous / next clip.
 *
 * Like recording, the camera is the only source of truth. What is shown (in playback or not,
 * playing or paused) comes from 10.1 reports; a request shows as pending until a report settles
 * it. The camera sends 10.1 only when it changes, so an acknowledged write without a report is
 * ambiguous; a session resync settles it (its burst starts with 10.1). A mode change is then sent
 * once more with the retry recipe; a speed or flag change is not (a camera that ignores it would
 * only keep the user waiting longer). 10.2 (clip step) is relative and not reported: it is sent
 * exactly once and only gets "sent" feedback.
 *
 * Safety:
 * - Nothing here ever writes transport mode 2 (record).
 * - Every 10.1 write is built when the queue sends it, from the latest report, and only if the
 *   camera is still in the mode the request started from. Leaving playback is the same packet
 *   as a record stop, so it must never reach a camera that started recording meanwhile.
 * - Entering playback is refused while recording or while a record request is pending.
 */

export interface PlaybackConfig {
	/** Recipes tried in order to enter or leave playback (mode-only first, full echo as retry). */
	modeRecipes: RecordRecipe[];
	/** Wait this long after an ack for a 10.1 report before resyncing. */
	confirmMs: number;
	/** How long the "sent" feedback of a clip step stays up. */
	feedbackMs: number;
}

export const DEFAULT_PLAYBACK_CONFIG: PlaybackConfig = {
	modeRecipes: ['B', 'A'],
	confirmMs: 2000,
	feedbackMs: 1200
};

export type PlaybackDisplay =
	| 'off'
	| 'unknown'
	| 'syncing'
	| 'entering'
	| 'leaving'
	| 'changing'
	| 'paused'
	| 'playing'
	| 'error';

export type PlaybackAction = 'enter' | 'exit' | 'speed' | 'flags' | 'step';

/** Why a playback action cannot be used right now. */
export type PlaybackBlock =
	| 'not-connected'
	| 'stale'
	| 'syncing'
	| 'unknown'
	| 'busy'
	| 'recording'
	| 'record-busy'
	| 'not-in-playback';

export type PlaybackResult = { ok: true } | { ok: false; reason: PlaybackBlock | 'invalid' };

export type PlaybackOpKind = 'enter' | 'exit' | 'speed' | 'loop' | 'playAll';

export interface PlaybackError {
	kind: PlaybackOpKind;
	reason: 'not-confirmed' | 'write-failed';
	detail?: string;
}

export interface PlaybackNotice {
	/** interrupted: the link dropped. cancelled: the camera changed mode before the write went out. */
	kind: 'interrupted' | 'cancelled';
}

export interface ClipFeedback {
	step: ClipStepValue;
	ok: boolean;
	at: number;
}

/** One write, built when the queue sends it. Throwing from `build` cancels the write. */
export interface PlaybackWrite {
	label: string;
	build(): Uint8Array;
}

export interface PlaybackDeps {
	state: CameraState;
	/** The link is up and synced, so a write can be sent. */
	connected(): boolean;
	/** Connected and the heartbeat is fresh, so reported values are current. */
	live(): boolean;
	/** A session resync is running. */
	syncing(): boolean;
	/** What the record button shows; entering playback waits for a pending record request. */
	record(): RecordDisplay;
	/** Session resync (see RecordDeps.resync). */
	resync(after: boolean): Promise<boolean>;
	/** Queue a write; resolves on the camera's write acknowledgement. Never replayed after a link loss. */
	send(write: PlaybackWrite): Promise<void>;
	now?: () => number;
	config?: Partial<PlaybackConfig>;
}

/** Thrown from a write's `build` when the camera is no longer in the mode the request was for. */
export class PlaybackCancelled extends Error {
	constructor(what: string) {
		super(`${what}: camera changed transport mode`);
	}
}

interface Target {
	mode: 0 | 1;
	speed?: number;
	flag?: { bit: number; on: boolean };
}

interface PendingOp {
	kind: PlaybackOpKind;
	target: Target;
	/** The transport mode the request starts from; writes are built only while it still holds. */
	from: 0 | 1;
	builders: { label: string; build: () => Uint8Array }[];
	attempt: number;
	stage: 'sent' | 'resync';
	acked: boolean;
	timer: ReturnType<typeof setTimeout> | null;
}

const MODE_TEXT: Record<0 | 1, string> = { 0: 'leave playback', 1: 'enter playback' };

export class PlaybackController {
	readonly config: PlaybackConfig;
	readonly #deps: PlaybackDeps;
	readonly #now: () => number;
	#feedbackTimer: ReturnType<typeof setTimeout> | null = null;

	// Raw: the timers compare the op by identity, which a deep proxy would break.
	#pending = $state.raw<PendingOp | null>(null);
	#stepBusy = $state(false);
	error = $state<PlaybackError | null>(null);
	notice = $state<PlaybackNotice | null>(null);
	/** Last clip step sent (or failed), for brief feedback. */
	feedback = $state<ClipFeedback | null>(null);
	/** Labels of the writes sent for the last request, for the debug view and tests. */
	lastWrites = $state<string[]>([]);

	constructor(deps: PlaybackDeps) {
		this.#deps = deps;
		this.#now = deps.now ?? Date.now;
		this.config = { ...DEFAULT_PLAYBACK_CONFIG, ...deps.config };
	}

	// ------------------------------------------------------------------ what to show

	/** The request in flight, if any. */
	get pending(): PlaybackOpKind | null {
		return this.#pending?.kind ?? null;
	}

	/** The speed being asked for while a speed change is pending. */
	get pendingSpeed(): number | null {
		const p = this.#pending;
		return p?.kind === 'speed' ? (p.target.speed ?? null) : null;
	}

	get display(): PlaybackDisplay {
		const p = this.#pending;
		if (p) return p.kind === 'enter' ? 'entering' : p.kind === 'exit' ? 'leaving' : 'changing';
		if (!this.#deps.live()) return 'unknown';
		if (this.error) return 'error';
		const s = this.#deps.state;
		if (!s.transport.fresh) return this.#deps.syncing() ? 'syncing' : 'unknown';
		if (s.transportMode !== TransportMode.play) return 'off';
		return this.speed === 0 ? 'paused' : 'playing';
	}

	/**
	 * Show the playback screen instead of the record button. A fresh recording report always wins,
	 * so a take started on the body shows the STOP button at once.
	 */
	get active(): boolean {
		const s = this.#deps.state;
		const mode = s.transportMode;
		if (s.transport.fresh && mode === TransportMode.record) return false;
		if (this.#pending) return true;
		if (!this.#deps.live()) return false;
		return mode === TransportMode.play && (s.transport.fresh || this.#deps.syncing() || this.error !== null);
	}

	/** Reported speed while in playback: 0 paused, +n forwards ×n, −n backwards ×n. */
	get speed(): number | null {
		const t = this.#playReport();
		return t ? t[1] : null;
	}

	get loop(): boolean | null {
		return this.#flag(TransportFlag.loop);
	}

	get playAll(): boolean | null {
		return this.#flag(TransportFlag.playAll);
	}

	/** Null when the action can be used; otherwise why not. Reactive. */
	block(action: PlaybackAction): PlaybackBlock | null {
		if (!this.#deps.connected()) return 'not-connected';
		if (!this.#deps.live()) return 'stale';
		if (this.#pending) return 'busy';
		const s = this.#deps.state;
		if (!s.transport.fresh) return this.#deps.syncing() ? 'syncing' : 'unknown';
		const mode = s.transportMode;
		if (action === 'enter') {
			const r = this.#deps.record();
			if (r === 'starting' || r === 'stopping') return 'record-busy';
			if (mode === TransportMode.record) return 'recording';
			return mode === TransportMode.preview || mode === TransportMode.play ? null : 'unknown';
		}
		if (mode === TransportMode.record) return 'recording';
		if (mode !== TransportMode.play) return 'not-in-playback';
		if (action === 'step' && this.#stepBusy) return 'busy';
		return null;
	}

	// ------------------------------------------------------------------ actions

	/** Switch the camera to playback (transport mode 1). Refused while recording. */
	enter(): PlaybackResult {
		const b = this.block('enter');
		if (b) return { ok: false, reason: b };
		if (this.#deps.state.transportMode === TransportMode.play) return { ok: true };
		this.#begin('enter', { mode: TransportMode.play }, TransportMode.preview, this.#modeBuilders(TransportMode.play));
		return { ok: true };
	}

	/** Back to the live camera (transport mode 0). */
	exit(): PlaybackResult {
		const b = this.block('exit');
		if (b) return { ok: false, reason: b };
		this.#begin('exit', { mode: TransportMode.preview }, TransportMode.play, this.#modeBuilders(TransportMode.preview));
		return { ok: true };
	}

	play(): PlaybackResult {
		return this.setSpeed(PlaybackSpeed.play);
	}

	pause(): PlaybackResult {
		return this.setSpeed(PlaybackSpeed.pause);
	}

	/** 0 pause, +n forwards ×n, −n backwards ×n. Nothing is sent when the camera already reports it. */
	setSpeed(speed: number): PlaybackResult {
		if (!Number.isInteger(speed) || speed < -128 || speed > 127) return { ok: false, reason: 'invalid' };
		const b = this.block('speed');
		if (b) return { ok: false, reason: b };
		if (this.speed === speed) return { ok: true };
		const label = speed === 0 ? 'pause' : speed === 1 ? 'play' : `speed ${speed}`;
		this.#begin('speed', { mode: TransportMode.play, speed }, TransportMode.play, [
			{ label: `playback ${label}`, build: () => buildTransportPacket(this.#deps.state.transport.confirmed, { mode: TransportMode.play, speed }) }
		]);
		return { ok: true };
	}

	setLoop(on: boolean): PlaybackResult {
		return this.#setFlag('loop', TransportFlag.loop, on);
	}

	setPlayAll(on: boolean): PlaybackResult {
		return this.#setFlag('playAll', TransportFlag.playAll, on);
	}

	previousClip(): PlaybackResult {
		return this.#step(ClipStep.previous);
	}

	nextClip(): PlaybackResult {
		return this.#step(ClipStep.next);
	}

	// ------------------------------------------------------------------ camera input

	/** Called by the session for every accepted 10.1 report, after CameraState was updated. */
	onTransport(_values: readonly number[]): void {
		// Any report overrides an error: it is the camera's current state.
		this.error = null;
		const p = this.#pending;
		if (!p) return;
		if (p.stage === 'resync') this.#judge(p);
		// Before the first ack the camera cannot have acted on our write yet, so only a report of
		// the requested state ends the request. After it, any report overrides.
		else if (this.#reached(p) || p.acked) this.#endPending();
	}

	/** The link dropped: whatever was in flight may or may not have reached the camera. */
	linkLost(): void {
		if (this.#pending) {
			this.#endPending();
			this.notice = { kind: 'interrupted' };
		}
		this.error = null;
		this.#stepBusy = false;
	}

	dismissNotice(): void {
		this.notice = null;
	}

	dismissError(): void {
		this.error = null;
	}

	// ------------------------------------------------------------------ internals

	#playReport(): readonly number[] | null {
		const s = this.#deps.state;
		const t = s.transport.confirmed;
		return s.transport.fresh && t && t.length >= 3 && t[0] === TransportMode.play ? t : null;
	}

	#flag(bit: number): boolean | null {
		const t = this.#playReport();
		return t ? (t[2] & bit) !== 0 : null;
	}

	#modeBuilders(mode: 0 | 1): PendingOp['builders'] {
		return this.config.modeRecipes.map((recipe) => {
			const label = `${MODE_TEXT[mode]} (${recipe})`;
			return { label, build: () => buildRecordPacket(recipe, mode, this.#deps.state.transport.confirmed).bytes };
		});
	}

	#setFlag(kind: 'loop' | 'playAll', bit: number, on: boolean): PlaybackResult {
		const b = this.block('flags');
		if (b) return { ok: false, reason: b };
		if (this.#flag(bit) === on) return { ok: true };
		const change = on ? { setFlags: bit } : { clearFlags: bit };
		this.#begin(kind, { mode: TransportMode.play, flag: { bit, on } }, TransportMode.play, [
			{
				label: `${kind === 'loop' ? 'loop' : 'play all'} ${on ? 'on' : 'off'}`,
				build: () => buildTransportPacket(this.#deps.state.transport.confirmed, { mode: TransportMode.play, ...change })
			}
		]);
		return { ok: true };
	}

	#step(step: ClipStepValue): PlaybackResult {
		const b = this.block('step');
		if (b) return { ok: false, reason: b };
		this.#stepBusy = true;
		const label = step === ClipStep.next ? 'next clip' : 'previous clip';
		this.#deps
			.send({
				label,
				build: () => {
					this.#requireMode(TransportMode.play, label);
					return clipStepPacket(step);
				}
			})
			.then(
				() => this.#feedback(step, true),
				() => this.#feedback(step, false)
			)
			.finally(() => (this.#stepBusy = false));
		return { ok: true };
	}

	#requireMode(mode: 0 | 1, what: string): void {
		const s = this.#deps.state;
		if (!s.transport.fresh || s.transportMode !== mode) throw new PlaybackCancelled(what);
	}

	#begin(kind: PlaybackOpKind, target: Target, from: 0 | 1, builders: PendingOp['builders']): void {
		this.error = null;
		this.notice = null;
		const op: PendingOp = { kind, target, from, builders, attempt: 0, stage: 'sent', acked: false, timer: null };
		this.#pending = op;
		this.lastWrites = [];
		this.#send(op);
	}

	#send(op: PendingOp): void {
		const attempt = op.attempt;
		const { label, build } = op.builders[attempt];
		this.lastWrites = [...this.lastWrites, label];
		const current = () => this.#pending === op && op.attempt === attempt && op.stage === 'sent';
		this.#deps
			.send({
				label,
				build: () => {
					this.#requireMode(op.from, label);
					return build();
				}
			})
			.then(
				() => {
					if (!current()) return;
					op.acked = true;
					op.timer = setTimeout(() => {
						op.timer = null;
						if (current()) this.#resyncToJudge(op);
					}, this.config.confirmMs);
				},
				(e: unknown) => {
					if (!current()) return;
					if (e instanceof PlaybackCancelled) this.#cancel();
					else this.#fail(op, 'write-failed', e instanceof Error ? e.message : String(e));
				}
			);
	}

	/** Acked but no report: the camera may have ignored it or already been in that state. */
	#resyncToJudge(op: PendingOp): void {
		op.stage = 'resync';
		const attempt = op.attempt;
		void this.#deps.resync(true).then(() => {
			if (this.#pending === op && op.stage === 'resync' && op.attempt === attempt) this.#judge(op);
		});
	}

	/** After a resync (or its first 10.1): satisfied, send the next recipe, or give up. */
	#judge(op: PendingOp): void {
		if (this.#reached(op)) return this.#endPending();
		const s = this.#deps.state;
		if (!s.transport.fresh) return this.#fail(op, 'not-confirmed');
		// The camera moved on by itself (a take started on the body, say): the request is moot.
		if (s.transportMode !== op.from) return this.#cancel();
		if (op.attempt + 1 < op.builders.length) {
			op.attempt++;
			op.stage = 'sent';
			this.#send(op);
			return;
		}
		this.#fail(op, 'not-confirmed');
	}

	#reached(op: PendingOp): boolean {
		const s = this.#deps.state;
		const t = s.transport.confirmed;
		if (!s.transport.fresh || !t || t[0] !== op.target.mode) return false;
		if (op.target.speed !== undefined && t[1] !== op.target.speed) return false;
		const f = op.target.flag;
		if (f && ((t[2] & f.bit) !== 0) !== f.on) return false;
		return true;
	}

	#cancel(): void {
		this.#endPending();
		this.notice = { kind: 'cancelled' };
	}

	#fail(op: PendingOp, reason: PlaybackError['reason'], detail?: string): void {
		this.#endPending();
		this.error = { kind: op.kind, reason, detail };
	}

	#endPending(): void {
		const p = this.#pending;
		if (!p) return;
		if (p.timer !== null) clearTimeout(p.timer);
		this.#pending = null;
	}

	#feedback(step: ClipStepValue, ok: boolean): void {
		this.feedback = { step, ok, at: this.#now() };
		if (this.#feedbackTimer !== null) clearTimeout(this.#feedbackTimer);
		this.#feedbackTimer = setTimeout(() => {
			this.#feedbackTimer = null;
			this.feedback = null;
		}, this.config.feedbackMs);
	}
}
