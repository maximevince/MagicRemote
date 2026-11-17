import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { encode, isoPacket, toHex } from '../protocol/index.ts';
import { FakeLink } from '../../test/fake-link.ts';
import { MODEL_BYTES, POWER_ON_BURST, PROTOCOL_BYTES, TIMECODE_SAMPLE } from '../../test/fixture.ts';
import { CameraSession } from './camera-session.svelte.ts';
import { MemoryKnownCameras } from './known-cameras.ts';

/** The controls wired into a session, driven by the captured Pocket 6K G2 burst. */

const advance = (ms: number) => vi.advanceTimersByTimeAsync(ms);

async function ready() {
	const link = new FakeLink();
	link.reads = { model: MODEL_BYTES, protocolVersion: PROTOCOL_BYTES };
	link.powerOnBurst = POWER_ON_BURST;
	const session = new CameraSession({ requestLink: async () => link, known: new MemoryKnownCameras() });
	void session.connect();
	for (let t = 0; t < 30_000 && session.phase !== 'ready'; t += 10) await advance(10);
	expect(session.phase).toBe('ready');
	const ticker = setInterval(() => link.emit('timecode', TIMECODE_SAMPLE), 86);
	await advance(100);
	return { link, session, stop: () => clearInterval(ticker) };
}

const controlWrites = (link: FakeLink) => link.outgoing().map((b) => toHex(b));

beforeEach(() => {
	vi.useFakeTimers();
});

afterEach(() => {
	vi.useRealTimers();
});

describe('CameraSession: camera controls', () => {
	it('picks up the controlled values from the captured burst', async () => {
		const { session, stop } = await ready();
		const s = session.state;
		expect(s.iso.confirmed).toBe(400);
		expect(s.sensitivityUnit).toBe('iso');
		expect(s.shutterAngle.confirmed).toBe(18000);
		expect(s.shutterUnit).toBe('angle');
		expect(s.aperture.confirmed).toBeCloseTo(4.1709, 3);
		expect(s.apertureUnits).toBe(0);
		expect(s.whiteBalance.confirmed).toEqual([5600, 10]);
		expect(s.codec.confirmed).toEqual([3, 1]);
		expect(s.recordingFormat.confirmed).toEqual([24, 24, 6144, 3456, 0]);
		expect(s.dynamicRange.confirmed).toBe(0);
		for (const id of ['iso', 'shutter', 'iris', 'autoIris', 'whiteBalance', 'autoWhiteBalance', 'focus'] as const) {
			expect(session.controls.block(id), id).toBeNull();
		}
		stop();
	});

	it('writes through the GATT queue, one operation at a time, and confirms on the echo', async () => {
		const { link, session, stop } = await ready();
		link.onWrite = (ch, data) => {
			if (ch === 'outgoing' && data[4] === 1 && data[5] === 14) {
				const v = new DataView(data.buffer, data.byteOffset).getInt32(8, true);
				setTimeout(() => link.emit('incoming', encode({ group: 1, param: 14, type: 'int32', op: 'status', values: [v] })), 80);
			}
		};
		session.controls.setIso(800);
		session.controls.setIso(1600);
		session.controls.setIso(3200);
		session.controls.autoFocus();
		expect(session.state.iso.value).toBe(3200);
		await advance(1000);
		expect(controlWrites(link)).toEqual([toHex(isoPacket(800)), toHex(isoPacket(3200)), 'ff04000000010000']);
		expect(link.maxInFlight).toBe(1);
		expect(session.state.iso.status).toBe('confirmed');
		expect(session.state.iso.value).toBe(3200);
		stop();
	});

	it('disables the controls while resyncing and after the link drops, and replays nothing', async () => {
		const { link, session, stop } = await ready();
		void session.resync('test');
		expect(session.controls.block('iso')).toBe('syncing');
		expect(session.controls.setIso(800)).toEqual({ ok: false, reason: 'syncing' });
		for (let t = 0; t < 20_000 && session.syncing; t += 10) await advance(10);
		expect(session.controls.block('iso')).toBeNull();

		session.controls.setIso(800);
		session.controls.setWhiteBalance(3200, 0);
		link.drop();
		expect(session.phase).toBe('reconnecting');
		expect(session.controls.block('iso')).toBe('reconnecting');
		expect(session.state.iso.status).toBe('unknown');
		expect(session.state.iso.expected).toBeUndefined();
		const before = link.outgoing().length;
		for (let t = 0; t < 30_000 && session.phase !== 'ready'; t += 10) await advance(10);
		expect(session.phase).toBe('ready');
		await advance(5000);
		expect(link.outgoing().length).toBe(before);
		stop();
	});

	it('blocks the controls in standby', async () => {
		const { link, session, stop } = await ready();
		link.emit('status', new Uint8Array([0x00]));
		expect(session.phase).toBe('standby');
		expect(session.controls.block('whiteBalance')).toBe('standby');
		expect(session.controls.autoWhiteBalance()).toEqual({ ok: false, reason: 'standby' });
		stop();
	});
});
