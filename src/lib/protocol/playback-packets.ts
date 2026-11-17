import { encode } from './codec.ts';
import { TransportMode, type TransportModeValue } from './transport-recipes.ts';

/**
 * Clip playback packets.
 *
 * - Entering and leaving playback are transport-mode writes (10.1 mode 1 / mode 0) and use the
 *   record recipes (`buildRecordPacket`), which are plain "assign mode = X".
 * - Speed (play, pause, shuttle) and the loop / play-all flags live inside 10.1 as well, so they
 *   are written as the full last-reported 10.1 array with only those fields changed.
 * - 10.2 steps one clip back or forward. It is relative: a repeated write skips another clip, so
 *   it is never retried.
 */

/** 10.2 values. */
export const ClipStep = { previous: 0, next: 1 } as const;
export type ClipStepValue = (typeof ClipStep)[keyof typeof ClipStep];

/** 10.1 speed: 0 pause, +n forwards ×n, −n backwards ×n. */
export const PlaybackSpeed = { pause: 0, play: 1 } as const;

/** 10.2 playback control: exactly one int8 element (two elements break "next" on some cameras). */
export function clipStepPacket(step: ClipStepValue): Uint8Array {
	if (step !== ClipStep.previous && step !== ClipStep.next) throw new RangeError(`invalid clip step: ${step}`);
	return encode({ group: 10, param: 2, type: 'int8', op: 'assign', values: [step] });
}

export interface TransportChange {
	mode: TransportModeValue;
	/** New speed, or keep the reported one. */
	speed?: number;
	/** Flag bits to set and to clear; every other bit is kept as reported. */
	setFlags?: number;
	clearFlags?: number;
}

const toInt8 = (v: number): number => {
	const b = v & 0xff;
	return b > 127 ? b - 256 : b;
};

/**
 * A 10.1 assign built from the last reported 10.1: same element count (the slot count varies by
 * model), with the mode, and optionally the speed and flag bits, changed. Throws without a usable
 * report, because a partial array would leave the camera to guess the missing fields.
 */
export function buildTransportPacket(lastTransport: readonly number[] | null | undefined, change: TransportChange): Uint8Array {
	if (!lastTransport || lastTransport.length < 3) throw new RangeError('no 10.1 report to build on');
	if (change.mode !== TransportMode.preview && change.mode !== TransportMode.play && change.mode !== TransportMode.record) {
		throw new RangeError(`invalid transport mode: ${change.mode}`);
	}
	const data = lastTransport.map(toInt8);
	data[0] = change.mode;
	if (change.speed !== undefined) {
		if (!Number.isInteger(change.speed) || change.speed < -128 || change.speed > 127) {
			throw new RangeError(`invalid playback speed: ${change.speed}`);
		}
		data[1] = change.speed;
	}
	const flags = ((data[2] & 0xff) | (change.setFlags ?? 0)) & ~(change.clearFlags ?? 0);
	data[2] = toInt8(flags);
	return encode({ group: 10, param: 1, type: 'int8', op: 'assign', values: data });
}
