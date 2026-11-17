import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { decodePacket, encode, toHex, type DataType } from '../protocol/index.ts';
import { GattQueue } from '../transport/gatt-queue.ts';
import { CameraControls, type LinkStatus } from './camera-controls.svelte.ts';
import { CameraState } from './camera-state.svelte.ts';

const advance = (ms: number) => vi.advanceTimersByTimeAsync(ms);

const report = (group: number, param: number, type: DataType, values: number[]) =>
	encode({ group, param, type, op: 'status', values });

const ISO = (v: number) => report(1, 14, 'int32', [v]);
const GAIN = (v: number) => report(1, 13, 'int8', [v]);
const ANGLE = (v: number) => report(1, 11, 'int32', [v]);
const SPEED = (v: number) => report(1, 12, 'int32', [v]);
const APERTURE = (av: number, units = 0) => report(0, 2, 'fixed16', [av, units]);
const WB = (k: number, t: number) => report(1, 2, 'int16', [k, t]);
const FORMAT = (f: number[]) => report(1, 9, 'int16', f);

/** Controls over a real GattQueue whose writes take `writeMs` and are recorded as hex. */
function rig() {
	const state = new CameraState();
	const env = { link: 'ready' as LinkStatus, live: true, syncing: false, writeMs: 50, fail: null as Error | null };
	const queue = new GattQueue({ timeoutMs: 3000 });
	const sent: string[] = [];
	const controls = new CameraControls({
		state,
		link: () => env.link,
		live: () => env.live,
		syncing: () => env.syncing,
		send: (w) =>
			queue.push({
				label: w.label,
				coalesce:
					w.coalesce === undefined
						? undefined
						: w.coalesce === 'replace'
							? { key: w.key, mode: 'replace' }
							: { key: w.key, mode: 'accumulate', deltas: w.coalesce.deltas },
				run: async (ctx) => {
					const bytes = w.build(ctx.deltas);
					await new Promise((r) => setTimeout(r, env.writeMs));
					if (env.fail) throw env.fail;
					sent.push(toHex(bytes));
				}
			})
	});
	const camera = (bytes: Uint8Array) => {
		const r = state.apply(decodePacket(bytes), Date.now());
		expect(r.rejected).toBeFalsy();
	};
	/** The parts of the captured burst the controls use. */
	const burst = () => {
		camera(ISO(400));
		camera(WB(5600, 10));
		camera(APERTURE(4.1709));
		camera(FORMAT([24, 24, 6144, 3456, 0]));
		camera(ANGLE(18000));
	};
	return { state, env, queue, sent, controls, camera, burst };
}

const hex = (bytes: Uint8Array) => toHex(bytes);
const isoHex = (v: number) => hex(encode({ group: 1, param: 14, type: 'int32', op: 'assign', values: [v] }));

beforeEach(() => {
	vi.useFakeTimers();
});

afterEach(() => {
	vi.useRealTimers();
});

describe('CameraControls: availability', () => {
	it('blocks everything with the link state as the reason', () => {
		const r = rig();
		r.burst();
		for (const [link, reason] of [
			['offline', 'offline'],
			['reconnecting', 'reconnecting'],
			['standby', 'standby']
		] as const) {
			r.env.link = link;
			expect(r.controls.block('iso')).toBe(reason);
			expect(r.controls.block('focus')).toBe(reason);
			expect(r.controls.block('autoWhiteBalance')).toBe(reason);
			expect(r.controls.setIso(800)).toEqual({ ok: false, reason });
			expect(r.controls.autoFocus()).toEqual({ ok: false, reason });
		}
		expect(r.queue.pending + Number(r.queue.busy)).toBe(0);
	});

	it('blocks while resyncing and while the heartbeat is stale', () => {
		const r = rig();
		r.burst();
		r.env.syncing = true;
		expect(r.controls.block('whiteBalance')).toBe('syncing');
		r.env.syncing = false;
		r.env.live = false;
		expect(r.controls.block('whiteBalance')).toBe('stale');
		r.env.live = true;
		expect(r.controls.block('whiteBalance')).toBeNull();
	});

	it('blocks a control whose value the camera has not reported', () => {
		const r = rig();
		expect(r.controls.block('iso')).toBe('unknown');
		expect(r.controls.block('shutter')).toBe('unknown');
		expect(r.controls.block('iris')).toBe('unknown');
		expect(r.controls.block('whiteBalance')).toBe('unknown');
		// Triggers have no value to wait for.
		expect(r.controls.block('autoWhiteBalance')).toBeNull();
		expect(r.controls.block('focus')).toBeNull();
		expect(r.controls.stepIso(1)).toEqual({ ok: false, reason: 'unknown' });
		expect(r.controls.stepKelvin(1)).toEqual({ ok: false, reason: 'unknown' });
		r.burst();
		for (const id of ['iso', 'shutter', 'iris', 'autoIris', 'whiteBalance'] as const) expect(r.controls.block(id)).toBeNull();
	});

	it('blocks values that are stale after a resync until reported again', () => {
		const r = rig();
		r.burst();
		r.state.markStale();
		expect(r.controls.block('iso')).toBe('unknown');
		r.camera(ISO(400));
		expect(r.controls.block('iso')).toBeNull();
	});

	it('makes ISO read-only in gain mode', () => {
		const r = rig();
		r.burst();
		r.camera(GAIN(6));
		expect(r.state.sensitivityUnit).toBe('gain');
		expect(r.controls.block('iso')).toBe('gain-mode');
		expect(r.controls.setIso(800)).toEqual({ ok: false, reason: 'gain-mode' });
		r.camera(ISO(800));
		expect(r.controls.block('iso')).toBeNull();
	});

	it('blocks iris and focus on a positive no-lens report', () => {
		const r = rig();
		r.burst();
		r.camera(report(0, 2, 'fixed16', [-16]));
		expect(r.controls.block('iris')).toBe('no-lens');
		expect(r.controls.block('autoIris')).toBe('no-lens');
		expect(r.controls.block('focus')).toBe('no-lens');
		expect(r.controls.nudgeFocus(0.01)).toEqual({ ok: false, reason: 'no-lens' });
		expect(r.controls.block('whiteBalance')).toBeNull();
	});
});

describe('CameraControls: absolute writes', () => {
	it('shows the expected value while pending, then the camera’s', async () => {
		const r = rig();
		r.burst();
		const iso = r.state.iso;
		expect(r.controls.setIso(800)).toEqual({ ok: true });
		expect(iso.status).toBe('pending');
		expect(iso.value).toBe(800);
		expect(iso.confirmed).toBe(400);
		await advance(50);
		expect(r.sent).toEqual([isoHex(800)]);
		expect(iso.status).toBe('pending');
		r.camera(ISO(800));
		expect(iso.status).toBe('pending'); // quiet period
		await advance(300);
		expect(iso.status).toBe('confirmed');
		expect(iso.expected).toBeUndefined();
		expect(iso.value).toBe(800);
		await advance(5000);
		expect(r.sent).toHaveLength(1);
		expect(iso.noEcho).toBe(false);
	});

	it('lets the camera’s clamped value win after the quiet period', async () => {
		const r = rig();
		r.burst();
		r.controls.setIso(25600);
		await advance(50);
		r.camera(ISO(12800));
		expect(r.state.iso.value).toBe(25600);
		await advance(300);
		expect(r.state.iso.value).toBe(12800);
	});

	it('retries an unechoed assign once, then flags it and shows the camera’s value', async () => {
		const r = rig();
		r.burst();
		r.controls.setIso(800);
		await advance(50 + 300 + 1500);
		expect(r.sent).toEqual([isoHex(800)]);
		expect(r.state.iso.status).toBe('pending'); // the retry is out
		await advance(50);
		expect(r.sent).toEqual([isoHex(800), isoHex(800)]);
		await advance(300 + 1500);
		expect(r.state.iso.noEcho).toBe(true);
		expect(r.state.iso.value).toBe(400);
		expect(r.sent).toHaveLength(2);
		// A later report clears the flag.
		r.camera(ISO(400));
		expect(r.state.iso.noEcho).toBe(false);
	});

	it('does not retry when the retry gets its echo', async () => {
		const r = rig();
		r.burst();
		r.controls.setIso(800);
		await advance(50 + 300 + 1500 + 50);
		r.camera(ISO(800));
		await advance(5000);
		expect(r.sent).toHaveLength(2);
		expect(r.state.iso.noEcho).toBe(false);
		expect(r.state.iso.value).toBe(800);
	});

	it('sends nothing when the value is already the camera’s', async () => {
		const r = rig();
		r.burst();
		expect(r.controls.setIso(400)).toEqual({ ok: true });
		await advance(5000);
		expect(r.sent).toEqual([]);
		expect(r.state.iso.status).toBe('confirmed');
	});

	it('rejects a value outside the registry range without sending', () => {
		const r = rig();
		r.burst();
		expect(r.controls.setIso(-100)).toEqual({ ok: false, reason: 'invalid' });
		expect(r.state.iso.status).toBe('confirmed');
	});

	it('drops `expected` at once when the write fails', async () => {
		const r = rig();
		r.burst();
		r.env.fail = new Error('GATT write failed');
		r.controls.setIso(800);
		expect(r.state.iso.value).toBe(800);
		await advance(50);
		expect(r.state.iso.status).toBe('confirmed');
		expect(r.state.iso.value).toBe(400);
		await advance(5000);
		expect(r.sent).toEqual([]);
	});

	it('never retries after the link was lost', async () => {
		const r = rig();
		r.burst();
		r.controls.setIso(800);
		await advance(50);
		r.controls.linkLost();
		r.state.invalidate();
		r.env.link = 'reconnecting';
		await advance(10_000);
		expect(r.sent).toHaveLength(1);
		expect(r.state.iso.status).toBe('unknown');
		expect(r.state.iso.noEcho).toBe(false);
	});
});

describe('CameraControls: coalescing', () => {
	it('sends only the latest of rapid taps (latest value wins)', async () => {
		const r = rig();
		r.burst();
		for (let i = 0; i < 6; i++) r.controls.stepIso(1);
		// Each step starts from the expected value: 400 → 500, 640, 800, 1000, 1250, 1600.
		expect(r.state.iso.value).toBe(1600);
		await advance(200);
		expect(r.sent).toEqual([isoHex(500), isoHex(1600)]);
		r.camera(ISO(1600));
		await advance(300);
		expect(r.state.iso.value).toBe(1600);
		expect(r.state.iso.status).toBe('confirmed');
	});

	it('keeps an earlier ack from ending the pending state of a newer value', async () => {
		const r = rig();
		r.burst();
		r.controls.setIso(800);
		await advance(10);
		r.controls.setIso(1600); // queued behind the in-flight 800
		await advance(40); // 800 acked
		r.camera(ISO(800));
		await advance(300);
		expect(r.state.iso.status).toBe('pending');
		expect(r.state.iso.value).toBe(1600);
		await advance(50);
		r.camera(ISO(1600));
		await advance(300);
		expect(r.state.iso.status).toBe('confirmed');
		expect(r.sent).toEqual([isoHex(800), isoHex(1600)]);
	});

	it('coalesces per parameter, not across parameters', async () => {
		const r = rig();
		r.burst();
		r.controls.setIso(800);
		r.controls.setIso(1600);
		r.controls.setShutter(9000);
		r.controls.setIso(3200);
		r.controls.setShutter(17280);
		await advance(500);
		expect(r.sent.map((h) => h.slice(8, 12))).toEqual(['010e', '010e', '010b']);
		expect(r.sent[1]).toBe(isoHex(3200));
		expect(decodePacket(Uint8Array.from(Buffer.from(r.sent[2], 'hex'))).values).toEqual([17280]);
	});

	it('adds up focus nudges instead of replacing them, and never retries them', async () => {
		const r = rig();
		r.burst();
		for (let i = 0; i < 4; i++) expect(r.controls.nudgeFocus(0.01)).toEqual({ ok: true });
		r.controls.nudgeFocus(-0.1);
		await advance(200);
		expect(r.sent).toHaveLength(2);
		const second = decodePacket(Uint8Array.from(Buffer.from(r.sent[1], 'hex')));
		expect(second.op).toBe('offset');
		expect(second.values![0]).toBeCloseTo(0.03 - 0.1, 3);
		expect(r.controls.feedback).toMatchObject({ key: 'lens.focus', ok: true });
		await advance(10_000);
		expect(r.sent).toHaveLength(2);
	});
});

describe('CameraControls: triggers', () => {
	it('sends auto WB, auto iris and autofocus once, without waiting for an echo', async () => {
		const r = rig();
		r.burst();
		expect(r.controls.autoWhiteBalance()).toEqual({ ok: true });
		expect(r.controls.autoWhiteBalance()).toEqual({ ok: false, reason: 'busy' });
		expect(r.controls.autoIris()).toEqual({ ok: true });
		expect(r.controls.autoFocus()).toEqual({ ok: true });
		await advance(200);
		expect(r.sent).toEqual(['ff04000001030000', 'ff04000000050000', 'ff04000000010000']);
		expect(r.state.whiteBalance.status).toBe('confirmed');
		expect(r.state.aperture.status).toBe('confirmed');
		expect(r.controls.feedback).toMatchObject({ key: 'lens.autoFocus', ok: true });
		await advance(10_000);
		expect(r.sent).toHaveLength(3);
		expect(r.controls.feedback).toBeNull();
		// Once sent, a new tap sends again.
		r.controls.autoWhiteBalance();
		await advance(100);
		expect(r.sent).toHaveLength(4);
	});

	it('reports a failed trigger and does not resend it', async () => {
		const r = rig();
		r.burst();
		r.env.fail = new Error('nope');
		r.controls.autoFocus();
		await advance(100);
		expect(r.controls.feedback).toMatchObject({ key: 'lens.autoFocus', ok: false });
		r.env.fail = null;
		await advance(10_000);
		expect(r.sent).toEqual([]);
	});
});

describe('CameraControls: per control', () => {
	it('writes the shutter in the unit the camera reports', async () => {
		const r = rig();
		r.burst();
		expect(r.controls.shutterOptions).toContain(17280);
		r.controls.stepShutter(1);
		expect(r.state.shutterAngle.value).toBe(21600);
		r.camera(SPEED(50));
		expect(r.state.shutterUnit).toBe('speed');
		expect(r.controls.shutterOptions[0]).toBe(24); // 24 fps from 1.9
		r.controls.setShutter(100);
		await advance(200);
		expect(r.sent[0].slice(8, 12)).toBe('010b');
		expect(r.sent[1]).toBe('ff080000010c030064000000');
	});

	it('steps the iris by a third of a stop from the shown value', async () => {
		const r = rig();
		r.burst();
		r.controls.stepIris(1);
		expect(r.state.aperture.value).toBeCloseTo(13 / 3);
		r.controls.stepIris(1);
		expect(r.state.aperture.value).toBeCloseTo(14 / 3);
		r.controls.stepIris(-1);
		expect(r.state.aperture.value).toBeCloseTo(13 / 3);
		await advance(200);
		const values = r.sent.map((h) => decodePacket(Uint8Array.from(Buffer.from(h, 'hex'))).values![0] as number);
		expect(values).toHaveLength(2);
		expect(values[0]).toBeCloseTo(13 / 3, 3);
		expect(values[1]).toBeCloseTo(13 / 3, 3);
	});

	it('keeps the tint when a Kelvin preset is chosen, and both go in one write', async () => {
		const r = rig();
		r.burst();
		r.controls.setKelvin(3200);
		expect(r.state.whiteBalance.value).toEqual([3200, 10]);
		await advance(60);
		r.controls.stepTint(-1);
		r.controls.stepKelvin(1);
		expect(r.state.whiteBalance.value).toEqual([3300, 9]);
		await advance(200);
		// The tint step goes out at once; the Kelvin step queued behind it carries both changes.
		expect(r.sent).toEqual(['ff08000001020200800c0a00', 'ff08000001020200800c0900', 'ff08000001020200e40c0900']);
	});

	it('clamps white balance into the camera range', () => {
		const r = rig();
		r.burst();
		r.controls.setWhiteBalance(20000, 80);
		expect(r.state.whiteBalance.value).toEqual([10000, 50]);
	});

	it('reads T-stop units from the second 0.2 element', () => {
		const r = rig();
		r.camera(APERTURE(4, 1));
		expect(r.state.apertureUnits).toBe(1);
		r.camera(APERTURE(4, 0));
		expect(r.state.apertureUnits).toBe(0);
	});
});
