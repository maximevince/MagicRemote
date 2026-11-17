import {
	CameraStatusBit,
	GattQueue,
	LinkError,
	QueueFlushedError,
	QueueStalledError,
	QueueTimeoutError,
	type CameraLink,
	type CharacteristicId,
	type QueueTask
} from '../transport/index.ts';
import { decodeTimecode, readCString, toHex } from '../protocol/index.ts';
import { CameraState } from './camera-state.svelte.ts';
import { cameraKey, type KnownCameraStore } from './known-cameras.ts';
import { PacketLog } from './packet-log.svelte.ts';
import { RecordController, type RecordConfig } from './record-controller.svelte.ts';

/**
 * One camera's connection state machine.
 *
 * idle → choosing → connecting → identifying → naming → pairing → subscribing → syncing → ready
 * (or standby). After a link loss: reconnecting, which runs the same handshake on the kept
 * device until it is back. Side exits: pairing-failed, bond-stale, failed, disconnected.
 *
 * Hard rules: nothing here unpairs or forgets a device; a known camera is
 * never paired again automatically (any auth or encryption failure on it is `bond-stale`, which
 * stops everything); only one connect attempt runs at a time.
 */

export type HandshakeStep = 'connecting' | 'identifying' | 'naming' | 'pairing' | 'subscribing' | 'syncing';

export type SessionPhase =
	| 'idle'
	| 'choosing'
	| HandshakeStep
	| 'standby'
	| 'ready'
	| 'reconnecting'
	| 'pairing-failed'
	| 'bond-stale'
	| 'failed'
	| 'disconnected';

export type FailureKind =
	| 'chooser-cancelled'
	| 'bluetooth-unavailable'
	| 'unsupported'
	| 'connect-failed'
	| 'pairing-failed'
	| 'pairing-interrupted'
	| 'bond-stale'
	| 'unexpected';

export interface SessionFailure {
	kind: FailureKind;
	/** Handshake step the failure happened in. */
	step?: HandshakeStep;
	detail?: string;
}

export interface SessionConfig {
	/** Our name as shown on the camera (≤ 32 bytes UTF-8). */
	deviceName: string;
	connectTimeoutMs: number;
	opTimeoutMs: number;
	/**
	 * Retries after the link drops before or during the first encrypted operation.
	 * Never applied to the pairing step of an unknown camera, because every new attempt there
	 * starts a new pairing with a new PIN. On a known camera, more consecutive drops than this
	 * at the encryption step are treated as a stale bond.
	 */
	earlyDropRetries: number;
	/** Pause between cleaning up a failed attempt and starting the next one. */
	retryCleanupMs: number;
	/** Reconnect backoff; the last value repeats while the page lives. */
	reconnectDelaysMs: readonly number[];
	/** No 10.1 this long into syncing ⇒ `burstMissing` action. */
	burstMissingMs: number;
	/** Whether resubscribing to Incoming re-triggers the initial burst is untested (M0). */
	burstMissing: 'resubscribe' | 'none';
	/** Give up waiting for the Camera Status ready bit and continue with what arrived. */
	syncTimeoutMs: number;
	/** No timecode/battery/indication this long ⇒ reported values are not current (record shows unknown). */
	heartbeatStaleMs: number;
	/** Silence this long while ready ⇒ treat the link as lost and reconnect. */
	heartbeatLostMs: number;
	heartbeatCheckMs: number;
	/** Whether timecode ticks in standby is untested (M0); off: no lost-link detection in standby. */
	heartbeatInStandby: boolean;
	/** Write Camera Status 0x01 once after the first pairing. */
	powerOnAfterFirstPairing: boolean;
	/** Protocol Version majors we know; others get a warning. */
	knownProtocolMajors: readonly string[];
	record?: Partial<RecordConfig>;
}

export const DEFAULT_SESSION_CONFIG: SessionConfig = {
	deviceName: 'MagicRemote',
	connectTimeoutMs: 20_000,
	opTimeoutMs: 3000,
	earlyDropRetries: 2,
	retryCleanupMs: 1000,
	reconnectDelaysMs: [2000, 5000, 10_000],
	burstMissingMs: 5000,
	burstMissing: 'resubscribe',
	syncTimeoutMs: 15_000,
	heartbeatStaleMs: 1000,
	heartbeatLostMs: 6000,
	heartbeatCheckMs: 250,
	heartbeatInStandby: false,
	powerOnAfterFirstPairing: true,
	knownProtocolMajors: ['0']
};

export interface SessionDeps {
	/** Opens the device chooser. Called synchronously from `connect()`, so keep it in a user gesture. */
	requestLink(options: { name?: string }): Promise<CameraLink>;
	known: KnownCameraStore;
	config?: Partial<SessionConfig>;
	now?: () => number;
	log?: PacketLog;
}

type FailKind = 'auth' | 'disconnected' | 'timeout' | 'cancelled' | 'other';

interface AttemptResult {
	ok: boolean;
	step?: HandshakeStep;
	kind?: FailKind;
	error?: unknown;
}

class Superseded extends Error {
	constructor() {
		super('superseded');
	}
}

const ACTIVE: ReadonlySet<SessionPhase> = new Set<SessionPhase>([
	'choosing',
	'connecting',
	'identifying',
	'naming',
	'pairing',
	'subscribing',
	'syncing',
	'standby',
	'ready',
	'reconnecting'
]);

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

function truncateUtf8(s: string, maxBytes: number): Uint8Array {
	const enc = new TextEncoder();
	let out = enc.encode(s);
	while (out.length > maxBytes) {
		s = Array.from(s).slice(0, -1).join('');
		out = enc.encode(s);
	}
	return out;
}

export class CameraSession {
	readonly config: SessionConfig;
	readonly state = new CameraState();
	readonly record: RecordController;
	readonly log: PacketLog;
	readonly queue: GattQueue;

	phase = $state<SessionPhase>('idle');
	/** Handshake step of the running attempt, also while `reconnecting`. */
	step = $state<HandshakeStep | null>(null);
	failure = $state.raw<SessionFailure | null>(null);
	/** Advertised name, e.g. "A:1A2B3C4D". */
	name = $state<string | null>(null);
	/** Bonded before: a PIN request or encryption failure now means the bond is stale. */
	known = $state(false);
	protocolWarning = $state<string | null>(null);
	/** Synced without a 10.1: record state is unknown, the UI shows separate Start and Stop. */
	syncIncomplete = $state(false);
	heartbeatFresh = $state(false);
	reconnectAttempt = $state(0);
	nextReconnectAt = $state<number | null>(null);

	readonly #deps: SessionDeps;
	readonly #now: () => number;
	#link: CameraLink | null = null;
	#offDisconnect: (() => void) | null = null;
	#unsubs = new Map<CharacteristicId, () => Promise<void>>();
	#mode: 'initial' | 'reconnect' = 'initial';
	/** Bumped by every connect run, reconnect loop, `disconnect()` and bond-stale; stale runs stop. */
	#run = 0;
	/** Bumped by every handshake attempt; listeners and steps of older attempts are ignored. */
	#conn = 0;
	#busy = false;
	#pairingDrops = 0;
	/** False from a link loss until the next successful connect. */
	#linkUp = false;
	#reconnectTimer: ReturnType<typeof setTimeout> | null = null;
	#heartbeatTimer: ReturnType<typeof setInterval> | null = null;
	#lastBeatAt = 0;
	#lastCheckAt = 0;
	#graceUntil = 0;
	#seenTransport = false;
	#readySeen = false;
	#syncCheck: (() => void) | null = null;
	#syncAbort: ((e: unknown) => void) | null = null;

	constructor(deps: SessionDeps) {
		this.#deps = deps;
		this.#now = deps.now ?? Date.now;
		this.config = { ...DEFAULT_SESSION_CONFIG, ...deps.config };
		this.log = deps.log ?? new PacketLog({ now: this.#now });
		this.queue = new GattQueue({ timeoutMs: this.config.opTimeoutMs, onTimeout: (e) => this.#onOpTimeout(e) });
		this.record = new RecordController({
			state: this.state,
			connected: () => this.phase === 'ready',
			live: () => this.live,
			send: (bytes, label) => this.#sendRecord(bytes, label),
			now: this.#now,
			config: this.config.record
		});
	}

	/** Connected, synced and hearing from the camera: what the state shows is current. */
	get live(): boolean {
		return this.phase === 'ready' && this.heartbeatFresh;
	}

	get busy(): boolean {
		return this.#busy;
	}

	get hasDevice(): boolean {
		return this.#link !== null;
	}

	/**
	 * Start a connection. `reuse` keeps the device chosen earlier in this page (no chooser).
	 * From `bond-stale` this is refused unless the user confirmed the recovery steps
	 * (`recovered`), which forgets the camera so that it pairs once more.
	 */
	async connect(options: { reuse?: boolean; recovered?: boolean } = {}): Promise<void> {
		if (this.#busy || ACTIVE.has(this.phase)) return;
		if (this.phase === 'bond-stale' && !options.recovered) return;
		const run = ++this.#run;
		this.#busy = true;
		this.failure = null;
		try {
			if (!(options.reuse && this.#link)) {
				this.phase = 'choosing';
				let link: CameraLink;
				try {
					link = await this.#deps.requestLink({});
				} catch (e) {
					this.#chooserFailed(e);
					return;
				}
				if (run !== this.#run) return;
				this.#adopt(link);
			}
			if (options.recovered) {
				this.#deps.known.forget(this.#key());
				this.log.add('session', { msg: 'bond recovery confirmed by the user; camera forgotten' });
			}
			this.known = this.#deps.known.has(this.#key());
			await this.#runInitial(run);
		} finally {
			if (run === this.#run) this.#busy = false;
		}
	}

	/** User disconnect (or cancelling a reconnect). Frees the camera for another controller. */
	async disconnect(): Promise<void> {
		this.#linkUp = false;
		this.#run++;
		this.#conn++;
		this.#busy = false;
		this.#clearReconnect();
		this.#stopHeartbeat();
		this.#abortSync(new QueueFlushedError('user'));
		this.queue.flush('user');
		this.record.linkLost();
		this.state.invalidate();
		this.phase = 'disconnected';
		this.step = null;
		this.log.add('session', { msg: 'disconnect requested' });
		try {
			await this.#link?.disconnect();
		} catch {
			/* already gone */
		}
	}

	/** Skip the backoff wait. */
	reconnectNow(): void {
		if (this.phase !== 'reconnecting' || this.#busy) return;
		this.#clearReconnect();
		void this.#reconnectOnce();
	}

	// ------------------------------------------------------------------ attempts

	async #runInitial(run: number): Promise<void> {
		this.#mode = 'initial';
		let drops = 0;
		for (;;) {
			const r = await this.#attempt();
			if (run !== this.#run) return;
			if (r.ok) return;
			const step = r.step!;
			const detail = message(r.error);
			this.log.add('error', { msg: `${step}: ${detail}`, kind: r.kind });
			if (r.kind === 'auth' || (step === 'pairing' && this.known && r.kind !== 'disconnected')) {
				if (this.known) return this.#bondStale(step, detail);
				await this.#cleanup();
				return this.#fail({ kind: 'pairing-failed', step, detail }, 'pairing-failed');
			}
			if (step === 'pairing' && !this.known) {
				// Never retried: every new attempt on an unbonded camera starts a pairing with a new PIN.
				await this.#cleanup();
				const kind = r.kind === 'disconnected' ? 'pairing-interrupted' : 'pairing-failed';
				return this.#fail({ kind, step, detail }, 'pairing-failed');
			}
			if (step === 'subscribing' || step === 'syncing') {
				// The bond worked, so this is an ordinary link loss.
				await this.#cleanup();
				if (run !== this.#run) return;
				this.#busy = false;
				this.#startReconnect();
				return;
			}
			const retryable = r.kind === 'disconnected' || r.kind === 'timeout';
			if (retryable && drops < this.config.earlyDropRetries) {
				drops++;
				this.log.add('session', { msg: `link dropped during ${step}; retry ${drops}/${this.config.earlyDropRetries}` });
				await this.#cleanup();
				await sleep(this.config.retryCleanupMs);
				if (run !== this.#run) return;
				continue;
			}
			await this.#cleanup();
			if (step === 'pairing') return this.#bondStale(step, `${detail} (link dropped at encryption ${drops + 1} times)`);
			return this.#fail({ kind: retryable ? 'connect-failed' : 'unexpected', step, detail }, 'failed');
		}
	}

	#startReconnect(): void {
		if (this.phase === 'reconnecting' || this.#busy) return;
		this.#run++;
		this.#mode = 'reconnect';
		this.phase = 'reconnecting';
		this.step = null;
		this.reconnectAttempt = 0;
		this.#pairingDrops = 0;
		this.log.add('session', { msg: 'link lost; reconnecting' });
		this.#scheduleReconnect();
	}

	#scheduleReconnect(): void {
		const delays = this.config.reconnectDelaysMs;
		const d = delays[Math.min(this.reconnectAttempt, delays.length - 1)];
		this.nextReconnectAt = this.#now() + d;
		this.#reconnectTimer = setTimeout(() => {
			this.#reconnectTimer = null;
			void this.#reconnectOnce();
		}, d);
	}

	async #reconnectOnce(): Promise<void> {
		if (this.phase !== 'reconnecting' || this.#busy || !this.#link) return;
		const run = this.#run;
		this.#busy = true;
		this.nextReconnectAt = null;
		this.reconnectAttempt++;
		try {
			const r = await this.#attempt();
			if (run !== this.#run || r.ok) return;
			const step = r.step!;
			const detail = message(r.error);
			this.log.add('error', { msg: `reconnect ${step}: ${detail}`, kind: r.kind });
			if (r.kind === 'auth' || (step === 'pairing' && r.kind !== 'disconnected')) return this.#bondStale(step, detail);
			if (step === 'pairing' && ++this.#pairingDrops > this.config.earlyDropRetries) {
				return this.#bondStale(step, `${detail} (link dropped at encryption ${this.#pairingDrops} times)`);
			}
			await this.#cleanup();
			if (run !== this.#run) return;
			this.phase = 'reconnecting';
			this.step = null;
			this.#scheduleReconnect();
		} finally {
			if (run === this.#run) this.#busy = false;
		}
	}

	/** One full handshake on the current link. Never throws. */
	async #attempt(): Promise<AttemptResult> {
		const token = ++this.#conn;
		const link = this.#link!;
		const cfg = this.config;
		this.#seenTransport = false;
		this.#readySeen = false;
		this.syncIncomplete = false;
		this.#unsubs.clear();
		const at = (s: HandshakeStep) => {
			if (token !== this.#conn) throw new Superseded();
			this.step = s;
			if (this.#mode === 'initial') this.phase = s;
		};
		const op = <T>(task: QueueTask<T>): Promise<T> => {
			if (token !== this.#conn) return Promise.reject(new Superseded());
			return this.queue.push(task);
		};
		try {
			at('connecting');
			await op({ label: 'connect', timeoutMs: cfg.connectTimeoutMs, run: () => link.connect() });
			this.#linkUp = true;
			this.log.add('connected', { name: link.name ?? null });

			at('identifying');
			const model = await this.#optionalRead(op, 'model');
			if (model) this.state.model = readCString(model);
			const version = await this.#optionalRead(op, 'protocolVersion');
			if (version) {
				const v = readCString(version);
				this.state.protocolVersion = v;
				const major = v.split('.')[0];
				this.protocolWarning = cfg.knownProtocolMajors.includes(major) ? null : `Unknown protocol version ${v}`;
			}

			at('naming');
			const nameBytes = truncateUtf8(cfg.deviceName, 32);
			try {
				await op({ label: 'write device name', run: () => link.write('deviceName', nameBytes) });
				this.log.add('out', { what: 'device-name', value: cfg.deviceName });
			} catch (e) {
				if (this.#fatal(e)) throw e;
				this.log.add('error', { msg: `device name: ${message(e)}` });
			}

			// The first encrypted operation: may trigger pairing and block on the PIN, so no timeout.
			at('pairing');
			const wasKnown = this.known;
			await this.#subscribe(op, 'status', null, (b) => this.#onStatus(token, b));
			this.#rememberCamera();
			if (!wasKnown && cfg.powerOnAfterFirstPairing) {
				try {
					await op({ label: 'write status 0x01', run: () => link.write('status', new Uint8Array([CameraStatusBit.power])) });
					this.log.add('out', { what: 'status', hex: '01' });
				} catch (e) {
					if (this.#fatal(e)) throw e;
					this.log.add('error', { msg: `power on: ${message(e)}` });
				}
			}

			at('subscribing');
			await this.#subscribe(op, 'incoming', undefined, (b) => this.#onIncoming(token, b));
			await this.#subscribe(op, 'timecode', undefined, (b) => this.#onTimecode(token, b));
			this.#startHeartbeat();

			at('syncing');
			await this.#sync(token, op);

			if (token !== this.#conn) throw new Superseded();
			this.step = null;
			this.phase = this.state.power === false ? 'standby' : 'ready';
			this.reconnectAttempt = 0;
			this.#pairingDrops = 0;
			this.log.add('session', { msg: `${this.phase}${this.syncIncomplete ? ' (initial state incomplete)' : ''}` });
			return { ok: true };
		} catch (e) {
			return { ok: false, step: this.step ?? 'connecting', kind: this.#classify(e), error: e };
		}
	}

	async #optionalRead(op: <T>(t: QueueTask<T>) => Promise<T>, ch: 'model' | 'protocolVersion'): Promise<Uint8Array | null> {
		const link = this.#link!;
		try {
			const bytes = await op({ label: `read ${ch}`, run: () => link.read(ch) });
			this.log.add('read', { what: ch === 'model' ? 'model' : 'protocol', value: readCString(bytes), hex: toHex(bytes) });
			return bytes;
		} catch (e) {
			if (this.#fatal(e)) throw e;
			this.log.add('error', { msg: `read ${ch}: ${message(e)}` });
			return null;
		}
	}

	async #subscribe(
		op: <T>(t: QueueTask<T>) => Promise<T>,
		ch: CharacteristicId,
		timeoutMs: number | null | undefined,
		listener: (b: Uint8Array) => void
	): Promise<void> {
		const link = this.#link!;
		const started = this.#now();
		const unsub = await op({ label: `subscribe ${ch}`, timeoutMs, run: () => link.subscribe(ch, listener) });
		this.#unsubs.set(ch, unsub);
		this.log.add('subscribed', { ch, took: (this.#now() - started) / 1000 });
	}

	/** Wait for the initial burst: 10.1 first, Camera Status ready bit at the end. */
	#sync(token: number, op: <T>(t: QueueTask<T>) => Promise<T>): Promise<void> {
		const cfg = this.config;
		return new Promise<void>((resolve, reject) => {
			const timers: ReturnType<typeof setTimeout>[] = [];
			let resubscribed = false;
			const done = () => {
				for (const t of timers) clearTimeout(t);
				this.#syncCheck = null;
				this.#syncAbort = null;
			};
			const finish = (incomplete: boolean) => {
				done();
				this.syncIncomplete = incomplete;
				resolve();
			};
			this.#syncAbort = (e) => {
				done();
				reject(e);
			};
			this.#syncCheck = () => {
				if (this.#seenTransport && this.#readySeen) finish(false);
			};
			const onMissing = async () => {
				if (this.#seenTransport || token !== this.#conn) return;
				if (cfg.burstMissing === 'resubscribe' && !resubscribed) {
					resubscribed = true;
					this.log.add('session', { msg: `no 10.1 after ${cfg.burstMissingMs} ms; resubscribing to Incoming` });
					try {
						const unsub = this.#unsubs.get('incoming');
						if (unsub) await op({ label: 'unsubscribe incoming', run: unsub });
						await this.#subscribe(op, 'incoming', undefined, (b) => this.#onIncoming(token, b));
					} catch (e) {
						this.#syncAbort?.(e);
						return;
					}
					timers.push(setTimeout(onMissing, cfg.burstMissingMs));
					return;
				}
				this.log.add('session', { msg: 'initial state never arrived; record state unknown' });
				finish(true);
			};
			timers.push(setTimeout(onMissing, cfg.burstMissingMs));
			timers.push(
				setTimeout(() => {
					this.log.add('session', { msg: 'no ready flag from Camera Status; continuing' });
					finish(!this.#seenTransport);
				}, cfg.syncTimeoutMs)
			);
		});
	}

	#abortSync(e: unknown): void {
		this.#syncAbort?.(e);
	}

	// ------------------------------------------------------------------ notifications

	#onStatus(token: number, bytes: Uint8Array): void {
		if (!this.#isCurrentConnection(token)) return;
		this.log.status(bytes);
		if (!bytes.length) return;
		this.#beat();
		const b = bytes[0];
		this.state.statusByte = b;
		if (this.step === 'syncing' && b & CameraStatusBit.ready) {
			this.#readySeen = true;
			this.#syncCheck?.();
		}
		if (this.phase === 'ready' && !(b & CameraStatusBit.power)) this.phase = 'standby';
		else if (this.phase === 'standby' && b & CameraStatusBit.power) this.phase = 'ready';
	}

	#onIncoming(token: number, bytes: Uint8Array): void {
		if (!this.#isCurrentConnection(token)) return;
		this.#beat();
		const at = this.#now();
		for (const p of this.log.incoming(bytes)) {
			const r = this.state.apply(p, at);
			if (r.rejected) {
				this.log.add('rejected', { id: `${p.group}.${p.param}`, hex: toHex(p.bytes) });
				continue;
			}
			if (r.key === 'media.transportMode') {
				this.#seenTransport = true;
				this.record.onTransport(p.values as number[]);
				this.#syncCheck?.();
			}
		}
	}

	#onTimecode(token: number, bytes: Uint8Array): void {
		if (!this.#isCurrentConnection(token)) return;
		this.#beat();
		this.log.timecode(bytes);
		const tc = decodeTimecode(bytes);
		if (tc) this.state.timecode = tc;
	}

	/** Listeners belong to the attempt that subscribed them; anything older is ignored. */
	#isCurrentConnection(token: number): boolean {
		return token === this.#conn && this.#linkUp;
	}

	// ------------------------------------------------------------------ heartbeat

	#beat(): void {
		this.#lastBeatAt = this.#now();
		if (!this.heartbeatFresh) this.heartbeatFresh = true;
	}

	#startHeartbeat(): void {
		this.#stopHeartbeat();
		const t = this.#now();
		this.#lastBeatAt = t;
		this.#lastCheckAt = t;
		this.#graceUntil = 0;
		this.heartbeatFresh = true;
		this.#heartbeatTimer = setInterval(() => this.#checkHeartbeat(), this.config.heartbeatCheckMs);
	}

	#stopHeartbeat(): void {
		if (this.#heartbeatTimer !== null) clearInterval(this.#heartbeatTimer);
		this.#heartbeatTimer = null;
		this.heartbeatFresh = false;
	}

	#checkHeartbeat(): void {
		const cfg = this.config;
		const t = this.#now();
		// A late timer (throttled or frozen tab) proves nothing: give notifications time to arrive.
		if (t - this.#lastCheckAt > cfg.heartbeatCheckMs * 4) this.#graceUntil = t + cfg.heartbeatStaleMs;
		this.#lastCheckAt = t;
		if (t < this.#graceUntil) return;
		const silent = t - this.#lastBeatAt;
		if (silent > cfg.heartbeatStaleMs && this.heartbeatFresh) {
			this.heartbeatFresh = false;
			this.log.add('session', { msg: `heartbeat stale (${silent} ms silent)` });
		}
		const supervised = this.phase === 'ready' || (this.phase === 'standby' && cfg.heartbeatInStandby);
		if (supervised && silent > cfg.heartbeatLostMs) {
			this.log.add('session', { msg: `heartbeat lost (${silent} ms silent); dropping the link` });
			this.#linkBroken();
		}
	}

	// ------------------------------------------------------------------ link loss

	#adopt(link: CameraLink): void {
		this.#offDisconnect?.();
		this.#link = link;
		this.name = link.name ?? null;
		this.#offDisconnect = link.onDisconnect(() => this.#onLinkDown(link));
	}

	#onLinkDown(link: CameraLink): void {
		// A late event from an earlier connection of a link that is up again.
		if (link !== this.#link || link.connected) return;
		this.log.add('disconnected');
		this.#linkGone(new LinkError('disconnected', 'link lost'));
	}

	#onOpTimeout(e: QueueTimeoutError): void {
		this.log.add('error', { msg: e.message });
		this.#linkBroken();
	}

	/** The link can't be trusted any more (op timeout, heartbeat lost): drop it and recover. */
	#linkBroken(): void {
		this.#linkGone(new LinkError('disconnected', 'link considered broken'));
		void this.#link?.disconnect().catch(() => {});
	}

	#linkGone(reason: LinkError): void {
		this.#linkUp = false;
		this.queue.flush(reason);
		this.#abortSync(reason);
		this.#stopHeartbeat();
		this.state.invalidate();
		this.record.linkLost();
		// A running attempt sees its operation fail and decides; otherwise recover from here.
		if (!this.#busy && (this.phase === 'ready' || this.phase === 'standby')) this.#startReconnect();
	}

	/** Fully clean up a failed attempt before another can start. */
	async #cleanup(): Promise<void> {
		this.#linkUp = false;
		this.#stopHeartbeat();
		this.#abortSync(new QueueFlushedError('cleanup'));
		this.queue.flush('cleanup');
		this.#unsubs.clear();
		if (this.#link?.connected) {
			try {
				await this.#link.disconnect();
			} catch {
				/* already gone */
			}
		}
		this.queue.flush('cleanup');
	}

	#bondStale(step: HandshakeStep, detail: string): void {
		this.#clearReconnect();
		void this.#cleanup();
		this.#run++;
		this.#conn++;
		this.#busy = false;
		this.failure = { kind: 'bond-stale', step, detail };
		this.phase = 'bond-stale';
		this.step = null;
		this.log.add('session', { msg: `bond-stale at ${step}: ${detail}; stopped` });
	}

	#fail(failure: SessionFailure, phase: 'failed' | 'pairing-failed'): void {
		this.failure = failure;
		this.phase = phase;
		this.step = null;
	}

	#chooserFailed(e: unknown): void {
		const err = e instanceof LinkError ? e : new LinkError('other', message(e), { cause: e });
		this.log.add('error', { msg: `chooser: ${err.message}`, kind: err.kind });
		const kind: FailureKind =
			err.kind === 'cancelled'
				? 'chooser-cancelled'
				: err.kind === 'not-found'
					? 'bluetooth-unavailable'
					: err.kind === 'unsupported'
						? 'unsupported'
						: 'unexpected';
		this.failure = { kind, detail: err.message };
		this.phase = this.#link ? 'disconnected' : 'idle';
	}

	#clearReconnect(): void {
		if (this.#reconnectTimer !== null) clearTimeout(this.#reconnectTimer);
		this.#reconnectTimer = null;
		this.nextReconnectAt = null;
	}

	// ------------------------------------------------------------------ helpers

	#key(): string {
		return cameraKey(this.#link?.name, this.#link?.id ?? 'unknown');
	}

	#rememberCamera(): void {
		this.known = true;
		this.#deps.known.remember(this.#key(), {
			name: this.#link?.name ?? '',
			model: this.state.model,
			lastSeen: this.#now()
		});
	}

	#sendRecord(bytes: Uint8Array, label: string): Promise<void> {
		const link = this.#link;
		if (!link) return Promise.reject(new LinkError('disconnected', 'no camera'));
		return this.queue.push({
			label,
			lane: 'urgent',
			run: async () => {
				this.log.outgoing(bytes, label);
				await link.write('outgoing', bytes);
			}
		});
	}

	/** Errors that end the attempt even in optional steps. */
	#fatal(e: unknown): boolean {
		const k = this.#classify(e);
		return k !== 'other';
	}

	#classify(e: unknown): FailKind {
		if (e instanceof Superseded) return 'cancelled';
		if (e instanceof QueueTimeoutError || e instanceof QueueStalledError) return 'timeout';
		if (e instanceof QueueFlushedError) {
			if (e.reason instanceof LinkError) return this.#classify(e.reason);
			return e.reason === 'user' ? 'cancelled' : 'disconnected';
		}
		if (e instanceof LinkError) {
			if (e.kind === 'auth') return 'auth';
			if (e.kind === 'disconnected') return 'disconnected';
			if (e.kind === 'cancelled') return 'cancelled';
			return 'other';
		}
		return 'other';
	}
}
