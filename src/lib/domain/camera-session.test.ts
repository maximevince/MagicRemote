import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildRecordPacket, encode, toHex } from '../protocol/index.ts';
import { LinkError } from '../transport/link.ts';
import { deferred, FakeLink } from '../../test/fake-link.ts';
import { BURST, MODEL_BYTES, POWER_ON_BURST, PROTOCOL_BYTES, READY_INDEX, TIMECODE_SAMPLE } from '../../test/fixture.ts';
import { CameraSession, type HandshakeStep, type SessionConfig, type SessionPhase } from './camera-session.svelte.ts';
import { MemoryKnownCameras } from './known-cameras.ts';

const KEY = '1A2B3C4D';
const advance = (ms: number) => vi.advanceTimersByTimeAsync(ms);

const transportReport = (mode: number) => FakeLink.transportReport(mode);
const RESYNC_WRITE = 'write status 01';

function harness(opts: { known?: boolean; config?: Partial<SessionConfig> } = {}) {
	const link = new FakeLink();
	link.reads = { model: MODEL_BYTES, protocolVersion: PROTOCOL_BYTES };
	// Like a link the browser kept up: nothing arrives on subscribing, the resync write brings the burst.
	link.powerOnBurst = POWER_ON_BURST;
	const known = new MemoryKnownCameras();
	if (opts.known) known.remember(KEY, { name: 'A:1A2B3C4D', model: null, lastSeen: 0 });
	const requestLink = vi.fn(async () => link);
	const session = new CameraSession({ requestLink, known, config: opts.config });

	let ticker: ReturnType<typeof setInterval> | null = null;
	const ticking = (on: boolean) => {
		if (ticker) clearInterval(ticker);
		ticker = on ? setInterval(() => link.emit('timecode', TIMECODE_SAMPLE), 86) : null;
	};

	/** The camera answers every record write with a 10.1 report of the requested mode. */
	const echoRecord = (delayMs = 100) => {
		link.onWrite = (ch, data) => {
			if (ch === 'outgoing' && data[4] === 10 && data[5] === 1) {
				setTimeout(() => link.emit('incoming', transportReport(data[8])), delayMs);
			}
		};
	};

	const untilStep = async (step: HandshakeStep, maxMs = 60_000) => {
		for (let t = 0; t < maxMs && session.step !== step; t += 10) await advance(10);
		expect(session.step).toBe(step);
	};

	const untilPhase = async (phase: SessionPhase, maxMs = 60_000) => {
		for (let t = 0; t < maxMs && session.phase !== phase; t += 10) await advance(10);
		expect(session.phase).toBe(phase);
	};

	const untilSynced = async (maxMs = 20_000) => {
		for (let t = 0; t < maxMs && session.syncing; t += 10) await advance(10);
		expect(session.syncing).toBe(false);
	};

	/** Replay the captured notifications up to and including the Camera Status ready flag. */
	const replayBurst = async (count = READY_INDEX + 1) => {
		let now = 0;
		for (const e of BURST.slice(0, count)) {
			await advance(e.at - now);
			now = e.at;
			link.emit(e.ch, e.bytes);
		}
		await advance(0);
	};

	const toReady = async () => {
		void session.connect();
		await untilPhase('ready');
		ticking(true);
	};

	const resyncWrites = () => link.ops.filter((o) => o === RESYNC_WRITE).length;

	return {
		link,
		known,
		session,
		requestLink,
		ticking,
		echoRecord,
		untilStep,
		untilPhase,
		untilSynced,
		replayBurst,
		toReady,
		resyncWrites
	};
}

beforeEach(() => {
	vi.useFakeTimers();
});

afterEach(() => {
	vi.useRealTimers();
});

describe('CameraSession: handshake', () => {
	it('replays the captured burst to ready, in handshake order', async () => {
		const h = harness();
		await h.toReady();
		const s = h.session;
		expect(h.link.ops.slice(0, 8)).toEqual([
			'connect',
			'read model',
			'read protocolVersion',
			`write deviceName ${toHex(new TextEncoder().encode('MagicRemote'))}`,
			'subscribe status',
			'subscribe incoming',
			'subscribe timecode',
			RESYNC_WRITE
		]);
		expect(h.link.maxInFlight).toBe(1);
		expect(s.state.model).toBe('Pocket Cinema Camera 6K G2');
		expect(s.state.protocolVersion).toBe('0.1.0');
		expect(s.protocolWarning).toBeNull();
		expect(s.state.statusByte).toBe(0x03);
		expect(s.state.batteryPercent).toBe(100);
		expect(s.state.activeSlot).toBe(2);
		expect(s.state.activeRemaining).toEqual({ kind: 'seconds', seconds: 27023 });
		expect(s.state.timecode).not.toBeNull();
		expect(s.syncIncomplete).toBe(false);
		expect(s.live).toBe(true);
		expect(s.record.display).toBe('preview');
		expect(s.known).toBe(true);
		expect(h.known.has(KEY)).toBe(true);
		expect(s.log.records.some((r) => r.kind === 'in' && r.ch === 'incoming')).toBe(true);
	});

	it('stays in syncing until Camera Status reports ready, even after 10.1 arrived', async () => {
		const h = harness();
		h.link.powerOnBurst = [];
		void h.session.connect();
		await h.untilStep('syncing');
		await h.replayBurst(READY_INDEX);
		expect(h.session.phase).toBe('syncing');
		expect(h.session.state.transportMode).toBe(0);
		h.link.emit('status', new Uint8Array([0x03]));
		await advance(0);
		expect(h.session.phase).toBe('ready');
	});

	it('waits for the PIN without a timeout in pairing', async () => {
		const h = harness();
		const pin = deferred();
		h.link.subscribePlan.status = [pin.promise];
		void h.session.connect();
		await h.untilStep('pairing');
		await advance(60_000);
		expect(h.session.phase).toBe('pairing');
		expect(h.session.queue.stalled).toBe(false);
		pin.resolve();
		await h.untilStep('syncing');
	});

	it('resyncs on every connect, a known camera included', async () => {
		const h = harness({ known: true });
		await h.toReady();
		expect(h.resyncWrites()).toBe(1);
		expect(h.session.syncing).toBe(false);
		expect(h.session.record.display).toBe('preview');
	});

	it('attaches to a live link with no burst, resyncs and shows the real state', async () => {
		const h = harness({ known: true });
		h.link.mode = 2;
		void h.session.connect();
		await h.untilStep('syncing');
		// Nothing arrives on its own.
		await advance(0);
		expect(h.session.state.transportMode).toBeNull();
		expect(h.session.log.records.some((r) => r.kind === 'in' && r.ch === 'incoming')).toBe(false);
		await h.untilPhase('ready');
		const ops = h.link.ops;
		expect(ops.indexOf(RESYNC_WRITE)).toBeGreaterThan(ops.indexOf('subscribe timecode'));
		expect(h.session.syncIncomplete).toBe(false);
		h.ticking(true);
		expect(h.session.record.display).toBe('recording');
		expect(h.session.record.alert).toBeNull();
	});

	it('can skip the resync on connect (?resync=0), then takes the burst of a fresh link', async () => {
		const h = harness({ config: { resyncOnConnect: false } });
		void h.session.connect();
		await h.untilStep('syncing');
		await h.replayBurst();
		expect(h.session.phase).toBe('ready');
		expect(h.resyncWrites()).toBe(0);
	});

	it('never resyncs before the encrypted step', async () => {
		const h = harness();
		const pin = deferred();
		h.link.subscribePlan.status = [pin.promise];
		void h.session.connect();
		await h.untilStep('pairing');
		expect(await h.session.resync()).toBe(false);
		expect(h.session.requestResync('tab visible')).toBe(false);
		await advance(1000);
		expect(h.link.writes.filter((w) => w.ch === 'status')).toHaveLength(0);
		pin.resolve();
		await h.untilPhase('ready');
		expect(h.resyncWrites()).toBe(1);
	});

	it('starts only one connect attempt at a time', async () => {
		const h = harness();
		void h.session.connect();
		void h.session.connect();
		await h.untilStep('syncing');
		void h.session.connect();
		expect(h.requestLink).toHaveBeenCalledTimes(1);
		expect(h.link.connectCount).toBe(1);
	});

	it('goes back to idle when the chooser is cancelled', async () => {
		const h = harness();
		h.requestLink.mockRejectedValueOnce(new LinkError('cancelled', 'User cancelled the requestDevice() chooser.'));
		await h.session.connect();
		expect(h.session.phase).toBe('idle');
		expect(h.session.failure?.kind).toBe('chooser-cancelled');
	});

	it('retries twice when the link drops before encryption, then fails plainly', async () => {
		const h = harness();
		const drop = () => new LinkError('disconnected', 'GATT Server is disconnected.');
		h.link.readPlan = [drop(), drop(), drop()];
		void h.session.connect();
		await advance(5000);
		expect(h.link.connectCount).toBe(3);
		expect(h.session.phase).toBe('failed');
		expect(h.session.failure).toMatchObject({ kind: 'connect-failed', step: 'identifying' });
	});

	it('recovers when a retry succeeds', async () => {
		const h = harness();
		h.link.readPlan = [new LinkError('disconnected', 'dropped')];
		void h.session.connect();
		await h.untilPhase('ready');
		expect(h.link.connectCount).toBe(2);
	});

	it('reports a failed first pairing without retrying (a retry would start a new PIN)', async () => {
		const h = harness();
		h.link.subscribePlan.status = [new LinkError('auth', 'Authentication canceled.')];
		await h.session.connect();
		await advance(60_000);
		expect(h.session.phase).toBe('pairing-failed');
		expect(h.session.failure).toMatchObject({ kind: 'pairing-failed', step: 'pairing' });
		expect(h.link.connectCount).toBe(1);
		expect(h.known.has(KEY)).toBe(false);
	});

	it('reports an interrupted first pairing (link dropped while the PIN was due)', async () => {
		const h = harness();
		const pin = deferred();
		h.link.subscribePlan.status = [pin.promise];
		void h.session.connect();
		await h.untilStep('pairing');
		await advance(30_000);
		h.link.drop();
		await advance(60_000);
		expect(h.session.phase).toBe('pairing-failed');
		expect(h.session.failure?.kind).toBe('pairing-interrupted');
		expect(h.link.connectCount).toBe(1);
	});

	it('treats an auth failure on a known camera as bond-stale, even on the first connect of the page', async () => {
		const h = harness({ known: true });
		h.link.subscribePlan.status = [new LinkError('auth', 'GATT operation not authorized.')];
		await h.session.connect();
		await advance(120_000);
		expect(h.session.phase).toBe('bond-stale');
		expect(h.link.connectCount).toBe(1);
	});

	it('resyncs once more when the camera state is missing, then shows record state unknown', async () => {
		const h = harness();
		h.link.powerOnBurst = [];
		void h.session.connect();
		await h.untilStep('syncing');
		h.ticking(true);
		await advance(100);
		expect(h.resyncWrites()).toBe(1);
		await advance(4900);
		expect(h.resyncWrites()).toBe(2);
		expect(h.link.ops).not.toContain('unsubscribe incoming');
		expect(h.session.phase).toBe('syncing');
		await advance(5000);
		expect(h.resyncWrites()).toBe(2);
		expect(h.session.phase).toBe('ready');
		expect(h.session.syncIncomplete).toBe(true);
		expect(h.session.record.display).toBe('unknown');
		expect(h.session.record.split).toBe(true);
		// The camera reports 10.1 later: the toggle comes back.
		h.link.emit('incoming', transportReport(0));
		expect(h.session.record.display).toBe('preview');
	});

	it('goes straight to record state unknown with ?burst=none', async () => {
		const h = harness({ config: { burstMissing: 'none' } });
		h.link.powerOnBurst = [];
		void h.session.connect();
		await h.untilStep('syncing');
		h.ticking(true);
		await advance(5000);
		expect(h.session.phase).toBe('ready');
		expect(h.session.syncIncomplete).toBe(true);
		expect(h.resyncWrites()).toBe(1);
	});

	it('warns on an unknown protocol major and continues', async () => {
		const h = harness();
		h.link.reads.protocolVersion = new TextEncoder().encode('1.0.0\0\0');
		await h.toReady();
		expect(h.session.protocolWarning).toMatch(/1\.0\.0/);
	});
});

describe('CameraSession: link loss and reconnect', () => {
	it('drops to reconnecting, shows nothing as current, and comes back to ready', async () => {
		const h = harness();
		await h.toReady();
		h.ticking(false);
		h.link.drop();
		const s = h.session;
		expect(s.phase).toBe('reconnecting');
		expect(s.record.display).toBe('unknown');
		expect(s.state.transport.status).toBe('unknown');
		expect(s.live).toBe(false);
		await advance(1999);
		expect(h.link.connectCount).toBe(1);
		await advance(1);
		await h.untilStep('syncing');
		expect(s.phase).toBe('reconnecting');
		await h.untilPhase('ready');
		expect(s.record.display).toBe('preview');
		expect(h.link.connectCount).toBe(2);
		// The resync write goes out on every connect.
		expect(h.resyncWrites()).toBe(2);
	});

	it('backs off 2 → 5 → 10 s while the camera is out of range', async () => {
		const h = harness();
		await h.toReady();
		h.ticking(false);
		const gone = () => new LinkError('disconnected', 'Bluetooth Device is no longer in range.');
		h.link.connectPlan = [gone(), gone(), gone(), gone()];
		h.link.drop();
		await advance(2000);
		expect(h.link.connectCount).toBe(2);
		await advance(4999);
		expect(h.link.connectCount).toBe(2);
		await advance(1);
		expect(h.link.connectCount).toBe(3);
		await advance(10_000);
		expect(h.link.connectCount).toBe(4);
		await advance(10_000);
		expect(h.link.connectCount).toBe(5);
		expect(h.session.phase).toBe('reconnecting');
		await h.untilPhase('ready', 20_000);
	});

	it('goes to bond-stale on an auth failure while reconnecting and never tries again', async () => {
		const h = harness();
		await h.toReady();
		h.ticking(false);
		h.link.subscribePlan.status = [new LinkError('auth', 'Authentication failed.')];
		h.link.drop();
		await advance(2000);
		await advance(0);
		expect(h.session.phase).toBe('bond-stale');
		expect(h.session.failure).toMatchObject({ kind: 'bond-stale', step: 'pairing' });
		const ops = h.link.ops.length;
		await advance(10 * 60_000);
		expect(h.link.connectCount).toBe(2);
		expect(h.link.ops.length).toBe(ops);
		// A plain connect does not leave bond-stale; only the confirmed recovery does.
		await h.session.connect({ reuse: true });
		expect(h.session.phase).toBe('bond-stale');
		expect(h.link.connectCount).toBe(2);
		expect(h.known.has(KEY)).toBe(true);
	});

	it('treats any encrypted-op failure on reconnect as bond-stale, not only auth errors', async () => {
		const h = harness();
		await h.toReady();
		h.ticking(false);
		h.link.subscribePlan.status = [new LinkError('other', 'GATT Error Unknown.')];
		h.link.drop();
		await advance(2001);
		expect(h.session.phase).toBe('bond-stale');
		await advance(60_000);
		expect(h.link.connectCount).toBe(2);
	});

	it('gives up with bond-stale after repeated drops at the encryption step', async () => {
		const h = harness();
		await h.toReady();
		h.ticking(false);
		const drop = () => new LinkError('disconnected', 'GATT Server is disconnected.');
		h.link.subscribePlan.status = [drop(), drop(), drop()];
		h.link.drop();
		await advance(2000 + 5000 + 10_000 + 100);
		expect(h.session.phase).toBe('bond-stale');
		expect(h.link.connectCount).toBe(4);
		await advance(60_000);
		expect(h.link.connectCount).toBe(4);
	});

	it('lets the user recover from bond-stale with one deliberate pairing', async () => {
		const h = harness({ known: true });
		h.link.subscribePlan.status = [new LinkError('auth', 'Authentication failed.')];
		await h.session.connect();
		expect(h.session.phase).toBe('bond-stale');
		void h.session.connect({ reuse: true, recovered: true });
		await h.untilPhase('ready');
		expect(h.requestLink).toHaveBeenCalledTimes(1);
		// The failed attempt stopped at the encrypted step, before any resync write.
		expect(h.resyncWrites()).toBe(1);
	});

	it('stops after a user disconnect and does not reconnect', async () => {
		const h = harness();
		await h.toReady();
		await h.session.disconnect();
		expect(h.session.phase).toBe('disconnected');
		await advance(60_000);
		expect(h.link.connectCount).toBe(1);
	});

	it('can cancel a reconnect loop', async () => {
		const h = harness();
		await h.toReady();
		h.ticking(false);
		h.link.connectPlan = [new LinkError('disconnected', 'gone')];
		h.link.drop();
		await advance(2000);
		await h.session.disconnect();
		await advance(60_000);
		expect(h.session.phase).toBe('disconnected');
		expect(h.link.connectCount).toBe(2);
	});

	it('treats an operation timeout as a broken link and reconnects', async () => {
		const h = harness();
		await h.toReady();
		h.link.writePlan.outgoing = [new Promise(() => {})];
		expect(h.session.record.start()).toEqual({ ok: true });
		await advance(3000);
		expect(h.session.phase).toBe('reconnecting');
		expect(h.link.ops).toContain('disconnect');
		expect(h.session.record.notice?.kind).toBe('interrupted');
		expect(h.session.queue.stalled).toBe(false);
	});
});

describe('CameraSession: heartbeat', () => {
	it('shows record state unknown while the heartbeat stalls, and recovers when it resumes', async () => {
		const h = harness();
		await h.toReady();
		await advance(1000);
		expect(h.session.record.display).toBe('preview');
		h.ticking(false);
		await advance(1300);
		expect(h.session.heartbeatFresh).toBe(false);
		expect(h.session.live).toBe(false);
		expect(h.session.record.display).toBe('unknown');
		expect(h.session.record.split).toBe(true);
		expect(h.session.phase).toBe('ready');
		expect(h.resyncWrites()).toBe(1);
		h.ticking(true);
		await advance(100);
		// Reports may have been missed during the stall: resync.
		expect(h.resyncWrites()).toBe(2);
		expect(h.session.record.display).toBe('syncing');
		await advance(100);
		expect(h.session.record.display).toBe('preview');
		await h.untilSynced();
		expect(h.session.record.display).toBe('preview');
	});

	it('drops and reconnects when the camera stays silent', async () => {
		const h = harness();
		await h.toReady();
		h.ticking(false);
		await advance(6500);
		expect(h.session.phase).toBe('reconnecting');
		expect(h.link.ops).toContain('disconnect');
	});

	it('does not treat a late timer (throttled tab) as a lost link', async () => {
		const h = harness();
		await h.toReady();
		h.ticking(false);
		// The clock jumps without timers running, as in a frozen tab.
		vi.setSystemTime(Date.now() + 30_000);
		await advance(300);
		expect(h.session.phase).toBe('ready');
		h.ticking(true);
		await advance(2000);
		expect(h.session.phase).toBe('ready');
		expect(h.session.live).toBe(true);
	});
});

describe('RecordController (through the session)', () => {
	it('shows recording only when a 10.1 echo confirms it, and stops the same way', async () => {
		const h = harness();
		await h.toReady();
		h.echoRecord(150);
		const r = h.session.record;
		expect(r.start()).toEqual({ ok: true });
		expect(r.display).toBe('starting');
		await advance(100);
		expect(h.link.outgoing()).toHaveLength(1);
		expect(toHex(h.link.outgoing()[0])).toBe('ff0500000a01010002000000');
		expect(r.display).toBe('starting');
		await advance(100);
		expect(r.display).toBe('recording');
		// Guard against a press right after the state flipped.
		expect(r.stop()).toEqual({ ok: false, reason: 'guard' });
		await advance(400);
		expect(r.stop()).toEqual({ ok: true });
		expect(r.display).toBe('stopping');
		await advance(300);
		expect(r.display).toBe('preview');
		expect(r.alert).toBeNull();
		expect(h.link.outgoing()).toHaveLength(2);
	});

	it('settles a stop the camera already was in: no echo, resync, satisfied, no error', async () => {
		const h = harness();
		await h.toReady();
		h.link.recordBehaviour = 'camera';
		// The app saw the take start, but missed the camera's own stop.
		h.link.emit('incoming', transportReport(2));
		h.link.mode = 0;
		await advance(400);
		const r = h.session.record;
		expect(r.display).toBe('recording');
		expect(r.stop()).toEqual({ ok: true });
		await advance(1990);
		expect(r.display).toBe('stopping');
		expect(h.resyncWrites()).toBe(1);
		await advance(20);
		expect(h.resyncWrites()).toBe(2);
		await advance(100);
		expect(r.display).toBe('preview');
		expect(r.error).toBeNull();
		expect(r.alert).toBeNull();
		expect(h.link.outgoing()).toHaveLength(1);
		await advance(10_000);
		expect(r.error).toBeNull();
		expect(h.link.outgoing()).toHaveLength(1);
	});

	it('settles a start whose echo was lost: resync shows recording, no retry', async () => {
		const h = harness();
		await h.toReady();
		h.link.onWrite = (ch, data) => {
			if (ch === 'outgoing' && data[4] === 10) h.link.mode = data[8];
		};
		const r = h.session.record;
		r.start();
		await advance(2200);
		expect(r.display).toBe('recording');
		expect(r.lastRecipes).toEqual(['B']);
		expect(h.link.outgoing()).toHaveLength(1);
	});

	it('retries once when the resync shows the camera ignored a start, then reports the real state', async () => {
		const h = harness();
		await h.toReady();
		h.link.recordBehaviour = 'ignore';
		h.link.mode = 0;
		const r = h.session.record;
		r.start();
		await advance(2010);
		expect(h.resyncWrites()).toBe(2);
		expect(h.link.outgoing()).toHaveLength(1);
		expect(r.display).toBe('starting');
		await advance(100);
		// The burst's 10.1 says preview: the retry recipe goes out.
		expect(h.link.outgoing()).toHaveLength(2);
		expect(toHex(h.link.outgoing()[1])).toBe(toHex(buildRecordPacket('A', 2, [0, 0, 16, 0, 1, 3]).bytes));
		expect(r.lastRecipes).toEqual(['B', 'A']);
		expect(r.display).toBe('starting');
		expect(r.error).toBeNull();
		await advance(2000);
		// The first resync is still receiving its burst; the judging one is queued behind it.
		expect(h.resyncWrites()).toBe(2);
		for (let t = 0; t < 10_000 && h.resyncWrites() < 3; t += 10) await advance(10);
		expect(h.resyncWrites()).toBe(3);
		expect(r.display).toBe('starting');
		await advance(100);
		expect(r.display).toBe('error');
		expect(r.error).toMatchObject({ intent: 'start', reason: 'not-confirmed', lastMode: 0 });
		expect(h.link.outgoing()).toHaveLength(2);
		await h.untilSynced();
		expect(r.display).toBe('error');
		// A later report wins.
		h.link.emit('incoming', transportReport(2));
		expect(r.display).toBe('recording');
		expect(r.error).toBeNull();
	});

	it('uses the configured recipes', async () => {
		const h = harness({ config: { record: { primary: 'A-prime', retry: 'B' } } });
		await h.toReady();
		h.session.record.start();
		await advance(2200);
		expect(h.session.record.lastRecipes).toEqual(['A-prime', 'B']);
		expect(toHex(h.link.outgoing()[1])).toBe('ff0500000a01010002000000');
	});

	it('cancels the resend when any 10.1 arrives after the ack', async () => {
		const h = harness();
		await h.toReady();
		const r = h.session.record;
		r.start();
		await advance(500);
		h.link.emit('incoming', transportReport(0));
		expect(r.display).toBe('preview');
		await advance(6000);
		expect(h.link.outgoing()).toHaveLength(1);
		expect(r.display).toBe('preview');
	});

	it('ignores presses while starting', async () => {
		const h = harness();
		await h.toReady();
		const r = h.session.record;
		r.start();
		expect(r.start()).toEqual({ ok: false, reason: 'busy' });
		expect(r.stop()).toEqual({ ok: false, reason: 'busy' });
	});

	it('refuses to start on a fresh "no media" reading for the active slot, and warns when unsure', async () => {
		const h = harness();
		await h.toReady();
		h.link.emit('incoming', encode({ group: 9, param: 1, type: 'int8', op: 'status', values: [0, 0, 0] }));
		await advance(400);
		expect(h.session.record.start()).toEqual({ ok: false, reason: 'no-media' });
		expect(h.session.record.notice).toEqual({ kind: 'no-media', slot: 2 });
		expect(h.link.outgoing()).toHaveLength(0);
	});

	it('refuses to start on a full card', async () => {
		const h = harness();
		await h.toReady();
		h.link.emit('incoming', encode({ group: 9, param: 2, type: 'int16', op: 'status', values: [0, 0, 0, 0] }));
		expect(h.session.record.start()).toEqual({ ok: false, reason: 'media-full' });
	});

	it('raises an alert on a stop the app did not request, and follows a start from the body', async () => {
		const h = harness();
		await h.toReady();
		const r = h.session.record;
		h.link.emit('incoming', transportReport(2));
		expect(r.display).toBe('recording');
		expect(r.alert).toBeNull();
		h.link.emit('incoming', transportReport(0));
		expect(r.display).toBe('preview');
		expect(r.alert?.kind).toBe('unrequested-stop');
	});

	it('alerts when a take stopped while the link was down', async () => {
		const h = harness();
		await h.toReady();
		h.link.emit('incoming', transportReport(2));
		h.ticking(false);
		h.link.drop();
		expect(h.session.record.display).toBe('unknown');
		await advance(2000);
		await h.untilPhase('ready');
		expect(h.session.record.display).toBe('preview');
		expect(h.session.record.alert?.kind).toBe('unrequested-stop');
	});

	it('offers separate start and stop when the state is unknown, and refuses when not connected', async () => {
		const h = harness();
		expect(h.session.record.start()).toEqual({ ok: false, reason: 'not-connected' });
		await h.toReady();
		h.ticking(false);
		await advance(1300);
		expect(h.session.record.split).toBe(true);
	});

	it('resyncs before acting on a press with the state unknown, and sends nothing when already there', async () => {
		const h = harness();
		await h.toReady();
		h.ticking(false);
		await advance(1300);
		const r = h.session.record;
		expect(r.display).toBe('unknown');
		h.ticking(true);
		expect(r.stop()).toEqual({ ok: true });
		expect(r.display).toBe('stopping');
		await advance(200);
		expect(h.resyncWrites()).toBe(2);
		expect(r.display).toBe('preview');
		expect(h.link.outgoing()).toHaveLength(0);
		expect(r.error).toBeNull();
	});

	it('resyncs before a start with the state unknown, then sends on the real state', async () => {
		const h = harness();
		h.link.powerOnBurst = [];
		void h.session.connect();
		await h.untilStep('syncing');
		h.ticking(true);
		await advance(10_000);
		const r = h.session.record;
		expect(h.session.syncIncomplete).toBe(true);
		expect(r.display).toBe('unknown');
		// The camera answers this time.
		h.link.powerOnBurst = POWER_ON_BURST;
		h.link.recordBehaviour = 'camera';
		h.link.mode = 0;
		expect(r.start()).toEqual({ ok: true });
		expect(r.display).toBe('starting');
		await advance(1000);
		// A start waits for the whole burst, so the media check uses current values.
		expect(h.link.outgoing()).toHaveLength(0);
		await h.untilSynced();
		expect(h.session.syncIncomplete).toBe(false);
		await advance(10);
		expect(h.link.outgoing()).toHaveLength(1);
		expect(r.notice).toBeNull();
		await advance(200);
		expect(r.display).toBe('recording');
	});

});

describe('CameraSession: resync', () => {
	it('marks the state stale until the camera resends it', async () => {
		const h = harness();
		await h.toReady();
		const s = h.session;
		const done = s.resync('test');
		expect(s.syncing).toBe(true);
		expect(s.state.transport.fresh).toBe(false);
		expect(s.record.display).toBe('syncing');
		expect(s.record.split).toBe(false);
		await advance(100);
		expect(s.record.display).toBe('preview');
		expect(s.syncing).toBe(true);
		await h.untilSynced();
		await expect(done).resolves.toBe(true);
		expect(s.state.batteryPercent).toBe(100);
	});

	it('coalesces concurrent resync requests into one write', async () => {
		const h = harness();
		await h.toReady();
		const s = h.session;
		const a = s.resync('a');
		const b = s.resync('b');
		expect(b).toBe(a);
		expect(s.requestResync('tab visible')).toBe(true);
		await advance(1000);
		expect(s.resync('c')).toBe(a);
		await h.untilSynced();
		await expect(a).resolves.toBe(true);
		expect(h.resyncWrites()).toBe(2);
		expect(h.link.maxInFlight).toBe(1);
	});

	it('debounces tab-return resyncs', async () => {
		const h = harness();
		await h.toReady();
		const s = h.session;
		expect(s.requestResync('tab visible')).toBe(true);
		await h.untilSynced();
		expect(h.resyncWrites()).toBe(2);
		expect(s.requestResync('tab visible')).toBe(false);
		expect(h.resyncWrites()).toBe(2);
		await advance(1000);
		expect(s.requestResync('tab visible')).toBe(true);
		await advance(10);
		expect(h.resyncWrites()).toBe(3);
	});

	it('resolves false when the camera does not resend, and leaves the state unknown', async () => {
		const h = harness();
		await h.toReady();
		h.link.powerOnBurst = [];
		const done = h.session.resync();
		await advance(5000);
		await expect(done).resolves.toBe(false);
		expect(h.session.syncing).toBe(false);
		expect(h.session.record.display).toBe('unknown');
		h.link.emit('incoming', transportReport(0));
		expect(h.session.record.display).toBe('preview');
	});

	it('does not resync in standby (the write would switch the camera on)', async () => {
		const h = harness();
		await h.toReady();
		h.link.emit('status', new Uint8Array([0x00]));
		expect(h.session.phase).toBe('standby');
		await expect(h.session.resync()).resolves.toBe(false);
		expect(h.session.requestResync('tab visible')).toBe(false);
		expect(h.resyncWrites()).toBe(1);
	});

	it('ends a resync cleanly when the link drops during it', async () => {
		const h = harness();
		await h.toReady();
		const done = h.session.resync();
		await advance(20);
		h.ticking(false);
		h.link.drop();
		await expect(done).resolves.toBe(false);
		expect(h.session.syncing).toBe(false);
		expect(h.session.phase).toBe('reconnecting');
	});
});
