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
 * While ready, `resync()` asks the camera to resend its whole state (see `#writeResync`).
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
	/** No 10.1 this long into a sync ⇒ `burstMissing` action (handshake) or give up (resync). */
	burstMissingMs: number;
	/** During the handshake: 'resync' writes Camera Status 0x01 once more; 'none' gives up at once. */
	burstMissing: 'resync' | 'none';
	/** Give up waiting for the Camera Status ready bit and continue with what arrived (handshake and resync). */
	syncTimeoutMs: number;
	/** No timecode/battery/indication this long ⇒ reported values are not current (record shows unknown). */
	heartbeatStaleMs: number;
	/** Silence this long while ready ⇒ treat the link as lost and reconnect. */
	heartbeatLostMs: number;
	heartbeatCheckMs: number;
	/** Whether timecode ticks in standby is untested (M0); off: no lost-link detection in standby. */
	heartbeatInStandby: boolean;
	/** Write Camera Status 0x01 on every connect, so the camera resends its full state. */
	resyncOnConnect: boolean;
	/** Automatic resyncs (tab return, heartbeat back after a stall) start at most this often. */
	autoResyncMinIntervalMs: number;
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
	burstMissing: 'resync',
	syncTimeoutMs: 15_000,
	heartbeatStaleMs: 1000,
	heartbeatLostMs: 6000,
	heartbeatCheckMs: 250,
	heartbeatInStandby: false,
	resyncOnConnect: true,
	autoResyncMinIntervalMs: 5000,
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
	/** A resync is running: reported values are current again one by one as the camera resends them. */
	syncing = $state(false);
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
	/** A sync is waiting for the Camera Status ready bit. */
	#awaitReady = false;
	/** The current connection passed the first encrypted operation (the bond is in use). */
	#encrypted = false;
	#resync: Promise<boolean> | null = null;
	#queuedResync: Promise<boolean> | null = null;
	#lastAutoResyncAt = -Infinity;
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
			syncing: () => this.syncing,
			resync: (after) => this.resync('record', { after }),
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
	 * From `bond-stale` a plain connect is refused. The user can either `retry`, which tries the
	 * stored pairing once more and keeps the camera known (so it is still never paired again
	 * automatically), or confirm the recovery steps (`recovered`), which forgets the camera so
	 * that it pairs once more.
	 */
	async connect(options: { reuse?: boolean; retry?: boolean; recovered?: boolean } = {}): Promise<void> {
		if (this.#busy || ACTIVE.has(this.phase)) return;
		if (this.phase === 'bond-stale' && !options.recovered && !options.retry) return;
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
			} else if (options.retry) {
				this.log.add('session', { msg: 'retry with the stored pairing requested by the user' });
			}
			this.known = this.#deps.known.has(this.#key());
			await this.#runInitial(run);
		} finally {
			if (run === this.#run) this.#busy = false;
		}
	}

	/**
	 * User disconnect (or cancelling a connect or reconnect). Closes this page's GATT connection
	 * and stops all reconnecting. Whether the computer then drops the Bluetooth link is up to the
	 * OS: on Linux (BlueZ) it stays up until the browser exits or the camera is disconnected in
	 * the system Bluetooth settings, so the camera may not be free for another controller yet.
	 */
	async disconnect(): Promise<void> {
		this.#linkUp = false;
		this.#encrypted = false;
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

	/**
	 * Ask the camera to resend its whole state. The state is marked stale until it is reported
	 * again. Resolves true once 10.1 and the Camera Status ready bit arrived, false if the camera
	 * did not resend or the link went away. A call during a running resync joins it, unless
	 * `after` is set: then the result must reflect something done before this call, so a new
	 * resync is queued behind the running one (one queued at most; later calls join it).
	 * Only while ready: in standby the write would switch the camera on.
	 */
	resync(reason = 'requested', opts: { after?: boolean } = {}): Promise<boolean> {
		if (this.#resync && opts.after) {
			return (this.#queuedResync ??= this.#resync.then(() => {
				this.#queuedResync = null;
				return this.resync(reason);
			}));
		}
		if (this.#resync) return this.#resync;
		if (this.phase !== 'ready' || this.#busy || !this.#linkUp || !this.#encrypted) return Promise.resolve(false);
		const token = this.#conn;
		const op = <T>(task: QueueTask<T>): Promise<T> =>
			token !== this.#conn ? Promise.reject(new Superseded()) : this.queue.push(task);
		this.log.add('session', { msg: `resync (${reason})` });
		this.syncing = true;
		this.#seenTransport = false;
		this.#readySeen = false;
		this.state.markStale();
		const p: Promise<boolean> = this.#sync(token, op, { write: true, retryOnMissing: false, armAfterWrite: true })
			.then(
				() => !this.syncIncomplete,
				() => false
			)
			.finally(() => {
				if (this.#resync !== p) return;
				this.#resync = null;
				this.syncing = false;
			});
		this.#resync = p;
		return p;
	}

	/** Resync after an event that may have hidden reports (tab return, heartbeat back), at most once per interval. */
	requestResync(reason: string): boolean {
		if (this.#resync) return true;
		if (this.phase !== 'ready') return false;
		const t = this.#now();
		if (t - this.#lastAutoResyncAt < this.config.autoResyncMinIntervalMs) return false;
		this.#lastAutoResyncAt = t;
		void this.resync(reason);
		return true;
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
		this.#encrypted = false;
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
			await this.#subscribe(op, 'status', null, (b) => this.#onStatus(token, b));
			this.#encrypted = true;
			this.#rememberCamera();

			at('subscribing');
			await this.#subscribe(op, 'incoming', undefined, (b) => this.#onIncoming(token, b));
			await this.#subscribe(op, 'timecode', undefined, (b) => this.#onTimecode(token, b));
			this.#startHeartbeat();

			// Everything is subscribed, so the resync burst is received. A fresh link also sends the
			// burst on its own; whichever 10.1 and ready bit come first end the sync.
			at('syncing');
			await this.#sync(token, op, {
				write: cfg.resyncOnConnect,
				retryOnMissing: cfg.burstMissing === 'resync',
				armAfterWrite: false
			});

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

	/**
	 * Writing Camera Status 0x01 ("power on") makes the camera resend its whole state: Status 0x01,
	 * the full initial burst (10.1 first), then Status 0x03. Otherwise that burst only comes on a
	 * fresh link, and the browser often re-attaches to a link that stayed up (page reload, our
	 * Disconnect), so this write is how the app resyncs. On a camera that is already on it has no
	 * visible effect. Never before the encrypted step: on an unbonded link it would start pairing.
	 */
	async #writeResync(op: <T>(t: QueueTask<T>) => Promise<T>): Promise<void> {
		const link = this.#link;
		if (!link || !this.#encrypted) throw new LinkError('other', 'resync refused before the encrypted step');
		await op({ label: 'write status 0x01', run: () => link.write('status', new Uint8Array([CameraStatusBit.power])) });
		this.log.add('out', { what: 'status', hex: '01' });
	}

	/**
	 * Wait for the camera's state: 10.1 first, Camera Status ready bit at the end.
	 * `write` sends the resync write first; `armAfterWrite` counts the ready bit only after it was
	 * acknowledged, so a ready bit still in flight from before cannot end the sync.
	 */
	#sync(
		token: number,
		op: <T>(t: QueueTask<T>) => Promise<T>,
		opts: { write: boolean; retryOnMissing: boolean; armAfterWrite: boolean }
	): Promise<void> {
		const cfg = this.config;
		return new Promise<void>((resolve, reject) => {
			const timers: ReturnType<typeof setTimeout>[] = [];
			let settled = false;
			let retried = false;
			const done = () => {
				settled = true;
				for (const t of timers) clearTimeout(t);
				this.#syncCheck = null;
				this.#syncAbort = null;
				this.#awaitReady = false;
			};
			const finish = (incomplete: boolean) => {
				if (settled) return;
				done();
				this.syncIncomplete = incomplete;
				resolve();
			};
			this.#syncAbort = (e) => {
				if (settled) return;
				done();
				reject(e);
			};
			this.#syncCheck = () => {
				if (this.#seenTransport && this.#readySeen) finish(false);
			};
			const write = async (what: string) => {
				try {
					await this.#writeResync(op);
				} catch (e) {
					if (this.#fatal(e)) return this.#syncAbort?.(e);
					this.log.add('error', { msg: `${what}: ${message(e)}` });
				}
				if (!settled) this.#awaitReady = true;
			};
			const onMissing = () => {
				if (settled || this.#seenTransport || token !== this.#conn) return;
				if (opts.retryOnMissing && !retried) {
					retried = true;
					this.log.add('session', { msg: `no 10.1 after ${cfg.burstMissingMs} ms; resyncing once` });
					void write('resync');
					timers.push(setTimeout(onMissing, cfg.burstMissingMs));
					return;
				}
				this.log.add('session', { msg: 'camera state never arrived; record state unknown' });
				finish(true);
			};
			timers.push(setTimeout(onMissing, cfg.burstMissingMs));
			timers.push(
				setTimeout(() => {
					this.log.add('session', { msg: 'no ready flag from Camera Status; continuing' });
					finish(!this.#seenTransport);
				}, cfg.syncTimeoutMs)
			);
			if (!opts.armAfterWrite) this.#awaitReady = true;
			if (opts.write) void write('resync on connect');
			else if (opts.armAfterWrite) this.#awaitReady = true;
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
		if (this.#awaitReady && b & CameraStatusBit.ready) {
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
		if (this.heartbeatFresh) return;
		this.heartbeatFresh = true;
		// After a stall, reports may have been missed.
		this.requestResync('heartbeat recovered');
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
		this.#encrypted = false;
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
		this.#encrypted = false;
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
