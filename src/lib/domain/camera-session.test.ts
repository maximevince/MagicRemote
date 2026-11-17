import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildRecordPacket, encode, toHex } from '../protocol/index.ts';
import { LinkError } from '../transport/link.ts';
import { deferred, FakeLink } from '../../test/fake-link.ts';
import { BURST, MODEL_BYTES, PROTOCOL_BYTES, READY_INDEX, TIMECODE_SAMPLE } from '../../test/fixture.ts';
import { CameraSession, type HandshakeStep, type SessionConfig } from './camera-session.svelte.ts';
import { MemoryKnownCameras } from './known-cameras.ts';

const KEY = '1A2B3C4D';
const advance = (ms: number) => vi.advanceTimersByTimeAsync(ms);

function transportReport(mode: number, rest: number[] = [0, 16, 0, 1, 3]): Uint8Array {
	return encode({ group: 10, param: 1, type: 'int8', op: 'status', values: [mode, ...rest] });
}

function harness(opts: { known?: boolean; config?: Partial<SessionConfig> } = {}) {
	const link = new FakeLink();
	link.reads = { model: MODEL_BYTES, protocolVersion: PROTOCOL_BYTES };
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
		await untilStep('syncing');
		await replayBurst();
		expect(session.phase).toBe('ready');
		ticking(true);
	};

	return { link, known, session, requestLink, ticking, echoRecord, untilStep, replayBurst, toReady };
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
			'write status 01',
			'subscribe incoming',
			'subscribe timecode'
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

	it('does not write power-on when reconnecting to a known camera', async () => {
		const h = harness({ known: true });
		await h.toReady();
		expect(h.link.ops).not.toContain('write status 01');
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
		await h.untilStep('syncing');
		await h.replayBurst();
		expect(h.session.phase).toBe('ready');
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

	it('resyncs once when the initial burst is missing, then shows record state unknown', async () => {
		const h = harness();
		void h.session.connect();
		await h.untilStep('syncing');
		h.ticking(true);
		await advance(5000);
		expect(h.link.ops.slice(-2)).toEqual(['unsubscribe incoming', 'subscribe incoming']);
		expect(h.session.phase).toBe('syncing');
		await advance(5000);
		expect(h.session.phase).toBe('ready');
		expect(h.session.syncIncomplete).toBe(true);
		expect(h.session.record.display).toBe('unknown');
		expect(h.session.record.split).toBe(true);
		// The camera reports 10.1 later: the toggle comes back.
		h.link.emit('incoming', transportReport(0));
		expect(h.session.record.display).toBe('preview');
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
		await h.replayBurst();
		expect(s.phase).toBe('ready');
		expect(s.record.display).toBe('preview');
		expect(h.link.connectCount).toBe(2);
		// Power-on is only written once, after the first pairing.
		expect(h.link.ops.filter((o) => o === 'write status 01')).toHaveLength(1);
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
		await h.untilStep('syncing', 15_000);
		await h.replayBurst();
		expect(h.session.phase).toBe('ready');
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
		await h.untilStep('syncing');
		expect(h.requestLink).toHaveBeenCalledTimes(1);
		// Treated as a first pairing again.
		expect(h.link.ops.filter((o) => o === 'write status 01')).toHaveLength(1);
		await h.replayBurst();
		expect(h.session.phase).toBe('ready');
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
		h.ticking(true);
		await advance(100);
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

	it('sends the retry recipe after 2 s without a 10.1, then fails at 5 s; a later 10.1 wins', async () => {
		const h = harness();
		await h.toReady();
		const r = h.session.record;
		r.start();
		await advance(1990);
		expect(h.link.outgoing()).toHaveLength(1);
		await advance(20);
		expect(h.link.outgoing()).toHaveLength(2);
		expect(toHex(h.link.outgoing()[1])).toBe(toHex(buildRecordPacket('A', 2, [0, 0, 16, 0, 1, 3]).bytes));
		expect(r.lastRecipes).toEqual(['B', 'A']);
		expect(r.display).toBe('starting');
		await advance(3000);
		expect(r.display).toBe('error');
		expect(r.error).toMatchObject({ intent: 'start', reason: 'not-confirmed', lastMode: 0 });
		expect(h.link.outgoing()).toHaveLength(2);
		h.link.emit('incoming', transportReport(2));
		expect(r.display).toBe('recording');
		expect(r.error).toBeNull();
	});

	it('uses the configured recipes', async () => {
		const h = harness({ config: { record: { primary: 'A-prime', retry: 'B' } } });
		await h.toReady();
		h.session.record.start();
		await advance(2100);
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
		await h.untilStep('syncing');
		await h.replayBurst();
		expect(h.session.record.display).toBe('preview');
		expect(h.session.record.alert?.kind).toBe('unrequested-stop');
	});

	it('offers separate start and stop when the state is unknown, and refuses when not connected', async () => {
		const h = harness();
		expect(h.session.record.start()).toEqual({ ok: false, reason: 'not-connected' });
		await h.toReady();
		h.ticking(false);
		await advance(1300);
		const r = h.session.record;
		expect(r.split).toBe(true);
		h.echoRecord(50);
		h.ticking(true);
		expect(r.stop()).toEqual({ ok: true });
		await advance(100);
		expect(r.display).toBe('preview');
	});
});
