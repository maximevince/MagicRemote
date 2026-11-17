import {
	aperturePacket,
	autoAperturePacket,
	autoFocusPacket,
	autoWhiteBalancePacket,
	byKey,
	checkValues,
	focusOffsetPacket,
	isoPacket,
	shutterAnglePacket,
	shutterSpeedPacket,
	whiteBalancePacket,
	type ParamDef
} from '../protocol/index.ts';
import { QUIET_PERIOD_MS, type CameraState, type Param } from './camera-state.svelte.ts';
import {
	clampKelvin,
	clampTint,
	irisStep,
	isNoLens,
	ISO_STOPS,
	kelvinStep,
	SHUTTER_ANGLES,
	speedsFor,
	stepInList,
	type Direction
} from './control-values.ts';

/**
 * Exposure, white balance and lens controls. The camera is the only source of truth: a write
 * sets the parameter's `expected` value (shown while pending), and the camera's report decides.
 *
 * Per the registry:
 * - absolute assigns coalesce in the GATT queue (latest value wins per parameter);
 * - parameters with `echoed: 'yes'` must be reported back after an acknowledged write. If no
 *   report arrives, a `retry: 'safe'` assign is sent once more, then the parameter is marked
 *   `noEcho` ("camera ignored this"). Nothing waits for an echo the registry says never comes;
 * - void triggers and focus offsets (`retry: 'never'`, or offsets in general) are sent exactly
 *   once. Offsets accumulate in the queue instead of being replaced.
 *
 * No Bluetooth here: writes go through `deps.send`, which the session puts on its GATT queue.
 */

export type ControlId = 'iso' | 'shutter' | 'iris' | 'autoIris' | 'whiteBalance' | 'autoWhiteBalance' | 'focus';

/** Why a control cannot be used right now. */
export type BlockReason =
	| 'offline'
	| 'reconnecting'
	| 'standby'
	| 'syncing'
	| 'stale'
	| 'unknown'
	| 'no-lens'
	| 'gain-mode';

export type LinkStatus = 'ready' | 'standby' | 'reconnecting' | 'offline';

export type WriteResult = { ok: true } | { ok: false; reason: BlockReason | 'busy' | 'limit' | 'invalid' };

/** One outgoing write, built when the queue sends it (so coalesced writes carry the latest value). */
export interface ControlWrite {
	label: string;
	/** Coalescing key (the registry key of the parameter). */
	key: string;
	/** 'replace': absolute assign, the latest queued value wins. `deltas`: offsets add up. */
	coalesce?: 'replace' | { deltas: readonly number[] };
	/** `deltas` is the queue's sum of every merged offset. */
	build(deltas?: readonly number[]): Uint8Array;
}

export interface ControlsConfig {
	/** Hold `expected` this long after the last ack. */
	quietMs: number;
	/** After the quiet period, wait this long for a report before retrying or flagging the write. */
	echoWaitMs: number;
	/** How long the "sent" feedback of a trigger or nudge stays up. */
	feedbackMs: number;
}

export const DEFAULT_CONTROLS_CONFIG: ControlsConfig = {
	quietMs: QUIET_PERIOD_MS,
	echoWaitMs: 1500,
	feedbackMs: 1200
};

export interface ControlsDeps {
	state: CameraState;
	link(): LinkStatus;
	/** Hearing from the camera, so reported values are current. */
	live(): boolean;
	/** A resync is running. */
	syncing(): boolean;
	/** Queue a write on the normal lane; resolves on the camera's write acknowledgement. */
	send(write: ControlWrite): Promise<void>;
	now?: () => number;
	config?: Partial<ControlsConfig>;
}

interface AssignSpec<T> {
	key: string;
	def: ParamDef;
	param: Param<T>;
	values(v: T): number[];
	encode(v: T): Uint8Array;
	label(v: T): string;
}

interface Track {
	seq: number;
	value: unknown;
	/** The parameter's report count when the write went out. */
	reportsAtSend: number | null;
	retried: boolean;
	timer: ReturnType<typeof setTimeout> | null;
}

export interface Feedback {
	key: string;
	ok: boolean;
	at: number;
}

function def(key: string): ParamDef {
	const d = byKey(key);
	if (!d) throw new Error(`${key} is not in the registry`);
	return d;
}

const same = (a: unknown, b: unknown): boolean =>
	Array.isArray(a) && Array.isArray(b) ? a.length === b.length && a.every((v, i) => v === b[i]) : a === b;

export class CameraControls {
	readonly config: ControlsConfig;
	readonly #deps: ControlsDeps;
	readonly #now: () => number;
	readonly #tracks = new Map<string, Track>();
	readonly #busyTriggers = new Set<string>();
	#feedbackTimer: ReturnType<typeof setTimeout> | null = null;

	/** Last trigger or nudge sent (or failed), for brief "sent" feedback in the UI. */
	feedback = $state<Feedback | null>(null);

	readonly #iso: AssignSpec<number>;
	readonly #angle: AssignSpec<number>;
	readonly #speed: AssignSpec<number>;
	readonly #aperture: AssignSpec<number>;
	readonly #wb: AssignSpec<[number, number]>;

	constructor(deps: ControlsDeps) {
		this.#deps = deps;
		this.#now = deps.now ?? Date.now;
		this.config = { ...DEFAULT_CONTROLS_CONFIG, ...deps.config };
		const s = deps.state;
		this.#iso = {
			key: 'video.iso',
			def: def('video.iso'),
			param: s.iso,
			values: (v) => [v],
			encode: isoPacket,
			label: (v) => `ISO ${v}`
		};
		this.#angle = {
			key: 'video.shutterAngle',
			def: def('video.shutterAngle'),
			param: s.shutterAngle,
			values: (v) => [v],
			encode: shutterAnglePacket,
			label: (v) => `shutter ${v / 100}°`
		};
		this.#speed = {
			key: 'video.shutterSpeed',
			def: def('video.shutterSpeed'),
			param: s.shutterSpeed,
			values: (v) => [v],
			encode: shutterSpeedPacket,
			label: (v) => `shutter 1/${v}`
		};
		this.#aperture = {
			key: 'lens.apertureFstop',
			def: def('lens.apertureFstop'),
			param: s.aperture,
			values: (v) => [v],
			encode: aperturePacket,
			label: (v) => `iris AV ${v.toFixed(2)}`
		};
		this.#wb = {
			key: 'video.whiteBalance',
			def: def('video.whiteBalance'),
			param: s.whiteBalance,
			values: (v) => [...v],
			encode: ([k, t]) => whiteBalancePacket(k, t),
			label: ([k, t]) => `WB ${k}K ${t}`
		};
	}

	// ------------------------------------------------------------------ availability

	/** Null when the control can be used; otherwise why not. Reactive. */
	block(id: ControlId): BlockReason | null {
		const link = this.#linkBlock();
		if (link) return link;
		const s = this.#deps.state;
		switch (id) {
			case 'iso':
				if (s.sensitivityUnit === 'gain') return 'gain-mode';
				return s.iso.fresh ? null : 'unknown';
			case 'shutter': {
				const p = this.#shutterSpec()?.param;
				return p?.fresh ? null : 'unknown';
			}
			case 'iris':
			case 'autoIris':
				if (!s.aperture.fresh) return 'unknown';
				return isNoLens(s.aperture.confirmed) ? 'no-lens' : null;
			case 'whiteBalance':
				return s.whiteBalance.fresh ? null : 'unknown';
			case 'autoWhiteBalance':
				return null;
			case 'focus':
				// Focus has no value to wait for; only a positive "no lens" report blocks it.
				return s.aperture.fresh && isNoLens(s.aperture.confirmed) ? 'no-lens' : null;
		}
	}

	#linkBlock(): BlockReason | null {
		const l = this.#deps.link();
		if (l !== 'ready') return l;
		if (this.#deps.syncing()) return 'syncing';
		if (!this.#deps.live()) return 'stale';
		return null;
	}

	// ------------------------------------------------------------------ ISO

	setIso(iso: number): WriteResult {
		return this.#assign('iso', this.#iso, Math.round(iso));
	}

	stepIso(dir: Direction): WriteResult {
		const next = stepInList(ISO_STOPS, this.#deps.state.iso.value, dir);
		return next === null ? this.#limit('iso') : this.setIso(next);
	}

	// ------------------------------------------------------------------ shutter

	/** Listed values in the unit the camera reports (angle × 100, or the x of 1/x). */
	get shutterOptions(): readonly number[] {
		const s = this.#deps.state;
		return s.shutterUnit === 'speed' ? speedsFor(this.#exposureFps()) : SHUTTER_ANGLES;
	}

	/** In the unit the camera reports. */
	setShutter(value: number): WriteResult {
		const spec = this.#shutterSpec();
		if (!spec) return { ok: false, reason: this.#linkBlock() ?? 'unknown' };
		return this.#assign('shutter', spec, Math.round(value));
	}

	stepShutter(dir: Direction): WriteResult {
		const spec = this.#shutterSpec();
		if (!spec) return { ok: false, reason: this.#linkBlock() ?? 'unknown' };
		const next = stepInList(this.shutterOptions, spec.param.value, dir);
		return next === null ? this.#limit('shutter') : this.setShutter(next);
	}

	#shutterSpec(): AssignSpec<number> | null {
		const u = this.#deps.state.shutterUnit;
		return u === 'angle' ? this.#angle : u === 'speed' ? this.#speed : null;
	}

	/** The frame rate that bounds the slowest shutter speed: sensor rate when off-speed, else file rate. */
	#exposureFps(): number | null {
		const f = this.#deps.state.recordingFormat.confirmed;
		if (!f || f.length < 5) return null;
		const offSpeed = (f[4] & 0x04) !== 0 && f[1] > 0;
		return (offSpeed ? f[1] : f[0]) || null;
	}

	// ------------------------------------------------------------------ iris

	/** +1 closes by a third of a stop (larger f-number), −1 opens. */
	stepIris(dir: Direction): WriteResult {
		const av = this.#deps.state.aperture.value;
		if (av === undefined) return { ok: false, reason: this.block('iris') ?? 'unknown' };
		const next = irisStep(av, dir);
		if (Math.abs(next - av) < 1e-3) return this.#limit('iris');
		return this.#assign('iris', this.#aperture, next);
	}

	autoIris(): WriteResult {
		return this.#trigger('autoIris', 'lens.autoAperture', autoAperturePacket, 'auto iris');
	}

	// ------------------------------------------------------------------ white balance

	setWhiteBalance(kelvin: number, tint: number): WriteResult {
		return this.#assign('whiteBalance', this.#wb, [clampKelvin(kelvin), clampTint(tint)]);
	}

	/** Changes Kelvin, keeps the tint shown. */
	setKelvin(kelvin: number): WriteResult {
		const wb = this.#deps.state.whiteBalance.value;
		if (!wb) return { ok: false, reason: this.block('whiteBalance') ?? 'unknown' };
		return this.setWhiteBalance(kelvin, wb[1]);
	}

	stepKelvin(dir: Direction): WriteResult {
		const wb = this.#deps.state.whiteBalance.value;
		if (!wb) return { ok: false, reason: this.block('whiteBalance') ?? 'unknown' };
		const k = kelvinStep(wb[0], dir);
		return k === wb[0] ? this.#limit('whiteBalance') : this.setWhiteBalance(k, wb[1]);
	}

	stepTint(dir: Direction): WriteResult {
		const wb = this.#deps.state.whiteBalance.value;
		if (!wb) return { ok: false, reason: this.block('whiteBalance') ?? 'unknown' };
		const t = clampTint(wb[1] + dir);
		return t === wb[1] ? this.#limit('whiteBalance') : this.setWhiteBalance(wb[0], t);
	}

	autoWhiteBalance(): WriteResult {
		return this.#trigger('autoWhiteBalance', 'video.autoWhiteBalance', autoWhiteBalancePacket, 'auto white balance');
	}

	// ------------------------------------------------------------------ focus

	autoFocus(): WriteResult {
		return this.#trigger('focus', 'lens.autoFocus', autoFocusPacket, 'autofocus');
	}

	/** Relative focus (EF lenses): positive towards far. Rapid nudges add up in the queue; never retried. */
	nudgeFocus(delta: number): WriteResult {
		const blocked = this.block('focus');
		if (blocked) return { ok: false, reason: blocked };
		if (!Number.isFinite(delta) || delta === 0) return { ok: false, reason: 'invalid' };
		const key = 'lens.focus';
		this.#deps
			.send({
				label: `focus ${delta > 0 ? 'far' : 'near'}`,
				key,
				coalesce: { deltas: [delta] },
				build: (deltas) => focusOffsetPacket(deltas?.[0] ?? delta)
			})
			.then(
				() => this.#feedback(key, true),
				() => this.#feedback(key, false)
			);
		return { ok: true };
	}

	// ------------------------------------------------------------------ lifecycle

	/** The link dropped: whatever was queued is gone, and nothing is retried on the next link. */
	linkLost(): void {
		for (const t of this.#tracks.values()) {
			t.seq++;
			if (t.timer !== null) clearTimeout(t.timer);
			t.timer = null;
		}
		this.#busyTriggers.clear();
	}

	// ------------------------------------------------------------------ internals

	#limit(id: ControlId): WriteResult {
		const blocked = this.block(id);
		return { ok: false, reason: blocked ?? 'limit' };
	}

	#track(key: string): Track {
		let t = this.#tracks.get(key);
		if (!t) {
			t = { seq: 0, value: undefined, reportsAtSend: null, retried: false, timer: null };
			this.#tracks.set(key, t);
		}
		return t;
	}

	#assign<T>(id: ControlId, spec: AssignSpec<T>, value: T): WriteResult {
		const blocked = this.block(id);
		if (blocked) return { ok: false, reason: blocked };
		if (!checkValues(spec.def, spec.values(value))) return { ok: false, reason: 'invalid' };
		const p = spec.param;
		// Nothing to change: the camera would not report anything back either.
		if (same(value, p.value)) return { ok: true };
		const t = this.#track(spec.key);
		t.seq++;
		t.value = value;
		t.retried = false;
		if (t.timer !== null) clearTimeout(t.timer);
		t.timer = null;
		p.expect(value);
		this.#write(spec, t, t.seq);
		return { ok: true };
	}

	#write<T>(spec: AssignSpec<T>, t: Track, seq: number): void {
		const value = t.value as T;
		this.#deps
			.send({
				label: spec.label(value),
				key: spec.key,
				coalesce: 'replace',
				build: () => {
					t.reportsAtSend = spec.param.reportCount;
					return spec.encode(t.value as T);
				}
			})
			.then(
				() => {
					// A newer write for this parameter follows; it decides.
					if (t.seq !== seq) return;
					spec.param.release(this.config.quietMs);
					if (spec.def.echoed !== 'yes') return;
					t.timer = setTimeout(() => this.#checkEcho(spec, t, seq), this.config.quietMs + this.config.echoWaitMs);
				},
				() => {
					if (t.seq === seq) spec.param.abandon();
				}
			);
	}

	#checkEcho<T>(spec: AssignSpec<T>, t: Track, seq: number): void {
		t.timer = null;
		if (t.seq !== seq) return;
		const p = spec.param;
		// Any report after the write counts, whatever its value: the camera snaps and clamps.
		if (t.reportsAtSend !== null && p.reportCount > t.reportsAtSend) return;
		if (this.#deps.link() !== 'ready') return;
		if (spec.def.retry === 'safe' && !t.retried) {
			t.retried = true;
			p.expect(t.value as T);
			this.#write(spec, t, seq);
			return;
		}
		p.noEcho = true;
	}

	#trigger(id: ControlId, key: string, build: () => Uint8Array, label: string): WriteResult {
		const blocked = this.block(id);
		if (blocked) return { ok: false, reason: blocked };
		// A trigger already queued or in flight: a second tap would only queue a duplicate.
		if (this.#busyTriggers.has(key)) return { ok: false, reason: 'busy' };
		this.#busyTriggers.add(key);
		this.#deps
			.send({ label, key, build })
			.then(
				() => this.#feedback(key, true),
				() => this.#feedback(key, false)
			)
			.finally(() => this.#busyTriggers.delete(key));
		return { ok: true };
	}

	#feedback(key: string, ok: boolean): void {
		this.feedback = { key, ok, at: this.#now() };
		if (this.#feedbackTimer !== null) clearTimeout(this.#feedbackTimer);
		this.#feedbackTimer = setTimeout(() => {
			this.#feedbackTimer = null;
			this.feedback = null;
		}, this.config.feedbackMs);
	}
}
