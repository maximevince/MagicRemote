import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildRecordPacket, toHex } from '../protocol/index.ts';
import { deferred, FakeLink } from '../../test/fake-link.ts';
import { MODEL_BYTES, POWER_ON_BURST, PROTOCOL_BYTES, TIMECODE_SAMPLE } from '../../test/fixture.ts';
import { CameraSession } from './camera-session.svelte.ts';
import { CameraState } from './camera-state.svelte.ts';
import { MemoryKnownCameras } from './known-cameras.ts';
import { PlaybackController, type PlaybackWrite } from './playback-controller.svelte.ts';

const advance = (ms: number) => vi.advanceTimersByTimeAsync(ms);
const RESYNC_WRITE = 'write status 01';

const ENTER_B = 'ff0500000a01010001000000';
const EXIT_B = 'ff0500000a01010000000000';
const PLAY = 'ff0a00000a0101000101100001030000';
const PAUSE = 'ff0a00000a0101000100100001030000';
const NEXT = 'ff0500000a02010001000000';
const PREVIOUS = 'ff0500000a02010000000000';

/** A ready session on the captured Pocket 6K G2 burst, with a camera that tracks its 10.1 state. */
async function ready() {
	const link = new FakeLink();
	link.reads = { model: MODEL_BYTES, protocolVersion: PROTOCOL_BYTES };
	link.powerOnBurst = POWER_ON_BURST;
	link.mode = 0;
	link.speed = 0;
	link.flags = 0x10;
	link.recordBehaviour = 'camera';
	const session = new CameraSession({ requestLink: async () => link, known: new MemoryKnownCameras() });
	void session.connect();
	for (let t = 0; t < 30_000 && session.phase !== 'ready'; t += 10) await advance(10);
	expect(session.phase).toBe('ready');
	let ticker: ReturnType<typeof setInterval> | null = setInterval(() => link.emit('timecode', TIMECODE_SAMPLE), 86);
	await advance(100);
	const out = () => link.outgoing().map((b) => toHex(b));
	const resyncWrites = () => link.ops.filter((o) => o === RESYNC_WRITE).length;
	const stopTicking = () => {
		if (ticker) clearInterval(ticker);
		ticker = null;
	};
	return { link, session, pb: session.playback, out, resyncWrites, stopTicking };
}

/** Enter playback and wait for the camera to confirm it. */
async function inPlayback() {
	const h = await ready();
	expect(h.pb.enter()).toEqual({ ok: true });
	await advance(300);
	expect(h.pb.display).toBe('paused');
	h.link.writes.length = 0;
	return h;
}

beforeEach(() => {
	vi.useFakeTimers();
});

afterEach(() => {
	vi.useRealTimers();
});

describe('PlaybackController (through the session)', () => {
	it('enters playback on a 10.1 report, not on the write', async () => {
		const { link, session, pb, out } = await ready();
		expect(pb.display).toBe('off');
		expect(pb.active).toBe(false);
		expect(session.controls.block('iso')).toBeNull();
		link.echoDelayMs = 400;
		expect(pb.enter()).toEqual({ ok: true });
		expect(pb.display).toBe('entering');
		expect(pb.active).toBe(true);
		// Pending: the camera controls are already out of the way.
		expect(session.controls.block('iso')).toBe('playback');
		await advance(100);
		expect(out()).toEqual([ENTER_B]);
		expect(pb.display).toBe('entering');
		await advance(400);
		expect(pb.display).toBe('paused');
		expect(pb.speed).toBe(0);
		expect(pb.loop).toBe(false);
		expect(pb.playAll).toBe(false);
		expect(session.record.display).toBe('playback');
		expect(session.controls.block('focus')).toBe('playback');
		expect(pb.lastWrites).toEqual(['enter playback (B)']);
		// Already there: nothing more is sent.
		expect(pb.enter()).toEqual({ ok: true });
		await advance(3000);
		expect(out()).toEqual([ENTER_B]);
		expect(pb.error).toBeNull();
	});

	it('plays and pauses by changing only the 10.1 speed, confirmed by the report', async () => {
		const { pb, out } = await inPlayback();
		expect(pb.play()).toEqual({ ok: true });
		expect(pb.display).toBe('changing');
		expect(pb.pendingSpeed).toBe(1);
		await advance(50);
		expect(out()).toEqual([PLAY]);
		await advance(150);
		expect(pb.display).toBe('playing');
		expect(pb.speed).toBe(1);
		// Explicit intents: play while playing sends nothing.
		expect(pb.play()).toEqual({ ok: true });
		expect(pb.pause()).toEqual({ ok: true });
		await advance(200);
		expect(out()).toEqual([PLAY, PAUSE]);
		expect(pb.display).toBe('paused');
		expect(pb.setSpeed(1.5)).toEqual({ ok: false, reason: 'invalid' });
	});

	it('steps clips with 10.2 exactly once per press and never retries', async () => {
		const { link, pb, out } = await inPlayback();
		expect(pb.nextClip()).toEqual({ ok: true });
		// A second press while the first is still queued is refused, not stacked.
		expect(pb.nextClip()).toEqual({ ok: false, reason: 'busy' });
		await advance(50);
		expect(out()).toEqual([NEXT]);
		expect(pb.feedback).toMatchObject({ step: 1, ok: true });
		expect(pb.previousClip()).toEqual({ ok: true });
		await advance(50);
		expect(out()).toEqual([NEXT, PREVIOUS]);
		expect(link.clipSteps).toEqual([1, 0]);
		// No report ever comes for 10.2; nothing is resent, no resync.
		await advance(10_000);
		expect(out()).toEqual([NEXT, PREVIOUS]);
		expect(pb.feedback).toBeNull();
		expect(pb.display).toBe('paused');
	});

	it('reports a failed clip step without retrying it', async () => {
		const { link, pb, out } = await inPlayback();
		link.writePlan.outgoing = [new Error('GATT write failed')];
		pb.nextClip();
		await advance(50);
		expect(pb.feedback).toMatchObject({ step: 1, ok: false });
		await advance(5000);
		expect(out()).toEqual([]);
		expect(link.clipSteps).toEqual([]);
		expect(pb.display).toBe('paused');
		expect(pb.active).toBe(true);
	});

	it('leaves playback back to the live camera', async () => {
		const { session, pb, out } = await inPlayback();
		pb.play();
		await advance(300);
		expect(pb.exit()).toEqual({ ok: true });
		expect(pb.display).toBe('leaving');
		await advance(300);
		expect(out()).toEqual([PLAY, EXIT_B]);
		expect(pb.display).toBe('off');
		expect(pb.active).toBe(false);
		expect(pb.speed).toBeNull();
		expect(session.record.display).toBe('preview');
		expect(session.record.alert).toBeNull();
		expect(session.controls.block('iso')).toBeNull();
	});

	it('toggles loop and play all through the 10.1 flags', async () => {
		const { pb, out } = await inPlayback();
		expect(pb.setLoop(true)).toEqual({ ok: true });
		await advance(300);
		expect(out()).toEqual(['ff0a00000a0101000100110001030000']);
		expect(pb.loop).toBe(true);
		pb.setPlayAll(true);
		await advance(300);
		expect(pb.playAll).toBe(true);
		pb.setLoop(false);
		await advance(300);
		expect(out()[2]).toBe('ff0a00000a0101000100120001030000');
		expect(pb.loop).toBe(false);
		expect(pb.playAll).toBe(true);
	});

	it('refuses to enter playback while recording or while a record request is pending', async () => {
		const { link, session, pb, out } = await ready();
		link.echoDelayMs = 300;
		expect(session.record.start()).toEqual({ ok: true });
		expect(pb.enter()).toEqual({ ok: false, reason: 'record-busy' });
		await advance(500);
		expect(session.record.display).toBe('recording');
		expect(pb.block('enter')).toBe('recording');
		expect(pb.enter()).toEqual({ ok: false, reason: 'recording' });
		expect(pb.active).toBe(false);
		for (const r of [pb.exit(), pb.play(), pb.nextClip(), pb.setLoop(true)]) expect(r).toEqual({ ok: false, reason: 'recording' });
		await advance(3000);
		expect(out()).toEqual(['ff0500000a01010002000000']);
	});

	it('shows the record button at once when a take starts on the body during playback', async () => {
		const { link, session, pb } = await inPlayback();
		expect(pb.active).toBe(true);
		link.mode = 2;
		link.emit('incoming', FakeLink.transportReport(2));
		expect(pb.active).toBe(false);
		expect(pb.display).toBe('off');
		expect(session.record.display).toBe('recording');
		expect(session.controls.block('iso')).toBeNull();
	});

	it('playback actions are refused outside playback', async () => {
		const { pb, out } = await ready();
		for (const r of [pb.exit(), pb.play(), pb.pause(), pb.previousClip(), pb.nextClip(), pb.setPlayAll(true)]) {
			expect(r).toEqual({ ok: false, reason: 'not-in-playback' });
		}
		await advance(1000);
		expect(out()).toEqual([]);
	});

	it('settles an entry whose report was lost by a resync, without a second write', async () => {
		const { link, pb, out, resyncWrites } = await ready();
		link.recordBehaviour = 'manual';
		link.onWrite = (ch, data) => {
			if (ch === 'outgoing' && data[4] === 10 && data[5] === 1) link.mode = data[8];
		};
		pb.enter();
		await advance(1990);
		expect(resyncWrites()).toBe(1);
		expect(pb.display).toBe('entering');
		await advance(100);
		expect(resyncWrites()).toBe(2);
		await advance(200);
		expect(pb.display).toBe('paused');
		expect(pb.error).toBeNull();
		expect(out()).toEqual([ENTER_B]);
	});

	it('retries an ignored entry once with the full-echo recipe, then reports the real state', async () => {
		const { link, pb, out, resyncWrites } = await ready();
		link.recordBehaviour = 'ignore';
		pb.enter();
		await advance(2010);
		expect(resyncWrites()).toBe(2);
		await advance(100);
		// The resync's 10.1 says preview: the retry recipe goes out, built from that report.
		expect(out()).toEqual([ENTER_B, toHex(buildRecordPacket('A', 1, [0, 0, 16, 0, 1, 3]).bytes)]);
		expect(pb.lastWrites).toEqual(['enter playback (B)', 'enter playback (A)']);
		expect(pb.display).toBe('entering');
		for (let t = 0; t < 15_000 && resyncWrites() < 3; t += 10) await advance(10);
		await advance(100);
		expect(pb.display).toBe('error');
		expect(pb.error).toEqual({ kind: 'enter', reason: 'not-confirmed', detail: undefined });
		expect(pb.active).toBe(false);
		expect(out()).toHaveLength(2);
		// Any later report wins.
		link.emit('incoming', FakeLink.transportReport(1));
		expect(pb.error).toBeNull();
		expect(pb.display).toBe('paused');
	});

	it('does not retry an ignored speed change: one write, one resync, then an error', async () => {
		const { link, pb, out, resyncWrites } = await inPlayback();
		link.transportFields = 'mode-only';
		const before = resyncWrites();
		pb.play();
		await advance(2010);
		expect(resyncWrites()).toBe(before + 1);
		for (let t = 0; t < 10_000 && pb.pending; t += 10) await advance(10);
		expect(pb.error).toMatchObject({ kind: 'speed', reason: 'not-confirmed' });
		expect(pb.display).toBe('error');
		expect(pb.active).toBe(true);
		expect(out()).toEqual([PLAY]);
		await advance(10_000);
		expect(out()).toEqual([PLAY]);
	});

	it('ends a pending request on link loss and never replays it after reconnecting', async () => {
		const { link, session, pb, out, stopTicking } = await inPlayback();
		link.writePlan.outgoing = [deferred().promise];
		expect(pb.nextClip()).toEqual({ ok: true });
		expect(pb.exit()).toEqual({ ok: true });
		// A clip step waits for a pending mode change to settle.
		expect(pb.previousClip()).toEqual({ ok: false, reason: 'busy' });
		await advance(20);
		stopTicking();
		link.drop();
		await advance(0);
		expect(pb.pending).toBeNull();
		expect(pb.notice).toEqual({ kind: 'interrupted' });
		expect(pb.active).toBe(false);
		expect(pb.feedback).toMatchObject({ ok: false });
		expect(session.phase).toBe('reconnecting');
		for (let t = 0; t < 60_000 && session.phase !== 'ready'; t += 10) await advance(10);
		expect(session.phase).toBe('ready');
		const ticker = setInterval(() => link.emit('timecode', TIMECODE_SAMPLE), 86);
		await advance(5000);
		// The reconnect burst says playback (the exit never reached the camera); nothing was resent.
		expect(out()).toEqual([]);
		expect(link.clipSteps).toEqual([]);
		expect(pb.display).toBe('paused');
		expect(pb.active).toBe(true);
		clearInterval(ticker);
	});
});

describe('PlaybackController: writes are built when sent', () => {
	function unit() {
		const state = new CameraState();
		const sent: PlaybackWrite[] = [];
		const acks: ReturnType<typeof deferred>[] = [];
		const pb = new PlaybackController({
			state,
			connected: () => true,
			live: () => true,
			syncing: () => false,
			record: () => 'playback',
			resync: async () => true,
			send: (w) => {
				sent.push(w);
				const d = deferred();
				acks.push(d);
				return d.promise;
			}
		});
		const report = (values: number[]) => {
			state.transport.report(values, 0);
			pb.onTransport(values);
		};
		return { state, pb, sent, acks, report };
	}

	it('cancels a queued write when the camera started recording before it went out', async () => {
		const { pb, sent, acks, report } = unit();
		report([1, 0, 16, 0, 1, 3]);
		pb.exit();
		expect(sent).toHaveLength(1);
		// A take starts on the body while the exit (the same bytes as a record stop) is queued.
		report([2, 0, 16, 0, 1, 3]);
		expect(pb.pending).toBe('exit');
		expect(() => sent[0].build()).toThrow(/changed transport mode/);
		acks[0].reject(new Error('camera changed transport mode'));
		await Promise.resolve();
	});

	it('never builds a speed or clip write unless the latest report is playback', () => {
		const { pb, sent, report } = unit();
		report([1, 0, 16, 0, 1, 3]);
		pb.play();
		pb.nextClip();
		report([2, 0, 16, 0, 1, 3]);
		for (const w of sent) expect(() => w.build()).toThrow();
	});

	it('builds speed writes from the latest report, not the one at the press', () => {
		const { pb, sent, report } = unit();
		report([1, 0, 16, 0, 1, 3]);
		pb.play();
		// The camera reports a flag change before the write leaves the queue.
		report([1, 0, 0x11, 0, 1, 3]);
		expect(toHex(sent[0].build())).toBe('ff0a00000a0101000101110001030000');
	});

	it('a cancelled request ends quietly with a notice, not an error', async () => {
		const { pb, sent, acks, report } = unit();
		report([1, 0, 16, 0, 1, 3]);
		pb.play();
		report([0, 0, 16, 0, 1, 3]);
		let err: unknown;
		try {
			sent[0].build();
		} catch (e) {
			err = e;
		}
		// Before the ack, a report of another state does not end the request.
		expect(pb.pending).toBe('speed');
		acks[0].reject(err);
		await Promise.resolve();
		await Promise.resolve();
		expect(pb.pending).toBeNull();
		expect(pb.error).toBeNull();
		expect(pb.notice).toEqual({ kind: 'cancelled' });
	});
});
