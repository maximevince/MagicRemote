/**
 * Byte-level link to one camera. Implementations: WebBluetoothLink and
 * SimulatedLink. A link knows nothing about camera semantics; callers serialise every
 * operation through a GattQueue, because the camera allows one GATT operation at a time.
 */

export const CAMERA_SERVICE = '291d567a-6d75-11e6-8b77-86f30ca893d3';
export const DEVICE_INFORMATION_SERVICE = 0x180a;

export const CHARACTERISTICS = {
	outgoing: '5dd3465f-1aee-4299-8493-d2eca2f8e1bb',
	incoming: 'b864e140-76a0-416a-bf30-5876504537d9',
	timecode: '6d8f2110-86f1-41bf-9afb-451d87e976c8',
	status: '7fe8691d-95dc-4fc5-8abd-ca74339b51b9',
	deviceName: 'ffac0c52-c9fb-41a0-b063-cc76282eb89c',
	protocolVersion: '8f1fd018-b508-456f-8f82-3d392bee2706',
	manufacturer: 0x2a29,
	model: 0x2a24
} as const;

export type CharacteristicId = keyof typeof CHARACTERISTICS;

/** Camera Status byte (verified on the Pocket 6K G2): bit0 power on, bit1 ready (initial burst done). */
export const CameraStatusBit = { power: 0x01, ready: 0x02 } as const;

export type Unsubscribe = () => void;

export interface CameraLink {
	/** Stable for the lifetime of the link object. */
	readonly id: string;
	/** Advertised name, e.g. "A:1A2B3C4D". */
	readonly name: string | undefined;
	readonly connected: boolean;

	/** Connect and (re)discover characteristics. Handles from a previous connection are discarded. */
	connect(): Promise<void>;
	disconnect(): Promise<void>;

	read(ch: CharacteristicId): Promise<Uint8Array>;
	/** Always write-with-response. */
	write(ch: CharacteristicId, data: Uint8Array): Promise<void>;
	/**
	 * Enable notifications or indications. Resolves once the CCCD write succeeded; on an
	 * encrypted characteristic this may first trigger pairing and block on the PIN dialog.
	 * The returned function stops notifications (itself a GATT operation).
	 */
	subscribe(ch: CharacteristicId, listener: (data: Uint8Array) => void): Promise<() => Promise<void>>;

	/** Called on every link loss, requested or not. Returns a function that removes the listener. */
	onDisconnect(listener: () => void): Unsubscribe;
}

/**
 * Why a link operation failed, as far as the platform lets us tell.
 * - `auth`: pairing or encryption failed (wrong or cancelled PIN, missing or stale bond, or a
 *   platform that cannot take the PIN at all).
 * - `disconnected`: the link dropped or could not be established.
 * - `cancelled`: the user closed the device chooser.
 * - `not-found`: no matching device, or the Bluetooth adapter is off or missing.
 * - `unsupported`: the browser or page cannot use Bluetooth (policy, insecure context).
 */
export type LinkErrorKind = 'auth' | 'disconnected' | 'cancelled' | 'not-found' | 'unsupported' | 'other';

export class LinkError extends Error {
	constructor(
		readonly kind: LinkErrorKind,
		message: string,
		options?: { cause?: unknown }
	) {
		super(message, options);
		this.name = 'LinkError';
	}
}
