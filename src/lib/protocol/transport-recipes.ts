import { encode } from './codec.ts';

/**
 * Record start/stop packets for transport mode 10.1.
 * Every recipe is "assign mode = X", so sending a second recipe as a retry is safe.
 */

export const TransportMode = { preview: 0, play: 1, record: 2 } as const;
export type TransportModeValue = (typeof TransportMode)[keyof typeof TransportMode];

/** 10.1 flag bits. */
export const TransportFlag = {
	loop: 0x01,
	playAll: 0x02,
	disk3Active: 0x10,
	disk1Active: 0x20,
	disk2Active: 0x40,
	timelapse: 0x80
} as const;

/** A: Blackmagic's sample code. A-prime: the fyxis variant that also works from playback. B: mode byte only. */
export type RecordRecipe = 'A' | 'A-prime' | 'B';

export interface RecordPacket {
	bytes: Uint8Array;
	/** The recipe actually used: A and A-prime fall back to B before any 10.1 has been received. */
	recipe: RecordRecipe;
}

const toInt8 = (v: number): number => {
	const b = v & 0xff;
	return b > 127 ? b - 256 : b;
};

/**
 * Build a 10.1 packet that sets the transport mode.
 * @param lastTransport the data of the last received 10.1 report (int8 elements, signed or
 *   unsigned), or null if none has arrived yet.
 */
export function buildRecordPacket(
	recipe: RecordRecipe,
	mode: TransportModeValue,
	lastTransport: readonly number[] | null | undefined
): RecordPacket {
	if (recipe === 'B' || !lastTransport || lastTransport.length === 0) {
		// cmdLen 5 = one int8 element (the mode); the trailing zeros are padding, so the camera
		// keeps speed, flags and slot media as they are.
		return { bytes: new Uint8Array([0xff, 0x05, 0x00, 0x00, 0x0a, 0x01, 0x01, 0x00, mode, 0, 0, 0]), recipe: 'B' };
	}
	// Echo the full array with the same element count: the slot count varies by model.
	const data = lastTransport.map(toInt8);
	data[0] = mode;
	if (recipe === 'A-prime' && data.length >= 3) {
		data[1] = 0;
		data[2] = toInt8(data[2] & ~(TransportFlag.loop | TransportFlag.playAll));
	}
	return {
		bytes: encode({ group: 10, param: 1, type: 'int8', op: 'assign', values: data }),
		recipe
	};
}
