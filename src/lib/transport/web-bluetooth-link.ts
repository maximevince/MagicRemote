import {
	CAMERA_SERVICE,
	CHARACTERISTICS,
	DEVICE_INFORMATION_SERVICE,
	LinkError,
	type CameraLink,
	type CharacteristicId,
	type LinkErrorKind,
	type Unsubscribe
} from './link.ts';

/**
 * CameraLink over Web Bluetooth. Deliberately thin: it maps the API onto
 * the interface and translates errors. Serialisation is the caller's job (CameraSession pushes
 * every call through its GattQueue); this class never retries, never pairs, unpairs or forgets.
 */

const DEVICE_INFO_CHARACTERISTICS: ReadonlySet<CharacteristicId> = new Set(['manufacturer', 'model']);

/**
 * Error messages that mean pairing or encryption failed. Chromium reports these as
 * NetworkError ("Authentication failed/canceled/rejected/timeout."), SecurityError ("GATT
 * operation not authorized.") or NetworkError ("GATT Error: Not paired."). How each OS
 * surfaces a passkey request that cannot be served is untested, so this list is a best guess.
 */
export const AUTH_ERROR_PATTERNS: readonly RegExp[] = [
	/authenticat/i,
	/not paired/i,
	/not authori[sz]ed/i,
	/insufficient (authentication|encryption)/i,
	/encrypt/i,
	/pairing/i
];

export function toLinkError(e: unknown): LinkError {
	if (e instanceof LinkError) return e;
	const name = e instanceof Error ? e.name : '';
	const message = e instanceof Error ? e.message : String(e);
	let kind: LinkErrorKind = 'other';
	if (AUTH_ERROR_PATTERNS.some((re) => re.test(message))) kind = 'auth';
	else if (name === 'NotFoundError') kind = /cancel/i.test(message) ? 'cancelled' : /no (services|characteristics)/i.test(message) ? 'other' : 'not-found';
	else if (name === 'NetworkError') kind = 'disconnected';
	else if (name === 'SecurityError') kind = 'unsupported';
	else if (name === 'NotAllowedError') kind = 'cancelled';
	return new LinkError(kind, message, { cause: e });
}

export function webBluetoothAvailable(nav: Navigator | undefined = globalThis.navigator): boolean {
	return !!nav && 'bluetooth' in nav && !!nav.bluetooth;
}

/**
 * Open Chrome's device chooser, narrowed to cameras (and to one name for a known camera).
 * Must be called from a user gesture, with nothing awaited before it.
 */
export async function requestCameraLink(
	bluetooth: Bluetooth,
	options: { name?: string } = {}
): Promise<WebBluetoothLink> {
	const filter: BluetoothLEScanFilter = options.name
		? { services: [CAMERA_SERVICE], name: options.name }
		: { services: [CAMERA_SERVICE] };
	try {
		const device = await bluetooth.requestDevice({
			filters: [filter],
			optionalServices: [DEVICE_INFORMATION_SERVICE]
		});
		return new WebBluetoothLink(device);
	} catch (e) {
		throw toLinkError(e);
	}
}

const copyBytes = (v: DataView): Uint8Array =>
	new Uint8Array(v.buffer.slice(v.byteOffset, v.byteOffset + v.byteLength));

export class WebBluetoothLink implements CameraLink {
	readonly #device: BluetoothDevice;
	readonly #chars = new Map<CharacteristicId, BluetoothRemoteGATTCharacteristic>();
	readonly #listeners = new Set<() => void>();
	#server: BluetoothRemoteGATTServer | null = null;

	constructor(device: BluetoothDevice) {
		this.#device = device;
		device.addEventListener('gattserverdisconnected', () => {
			this.#chars.clear();
			this.#server = null;
			for (const l of [...this.#listeners]) l();
		});
	}

	get id(): string {
		return this.#device.id;
	}

	get name(): string | undefined {
		return this.#device.name ?? undefined;
	}

	get connected(): boolean {
		return this.#device.gatt?.connected ?? false;
	}

	async connect(): Promise<void> {
		this.#chars.clear();
		const gatt = this.#device.gatt;
		if (!gatt) throw new LinkError('other', 'device has no GATT server');
		try {
			const server = await gatt.connect();
			const service = await server.getPrimaryService(CAMERA_SERVICE);
			const byUuid = new Map((await service.getCharacteristics()).map((c) => [c.uuid.toLowerCase(), c]));
			for (const [id, uuid] of Object.entries(CHARACTERISTICS) as [CharacteristicId, string | number][]) {
				if (typeof uuid !== 'string') continue;
				const c = byUuid.get(uuid);
				if (c) this.#chars.set(id, c);
			}
			this.#server = server;
		} catch (e) {
			throw toLinkError(e);
		}
	}

	/** Not `forget()`: that would revoke the page's permission for the device. */
	async disconnect(): Promise<void> {
		this.#device.gatt?.disconnect();
	}

	async read(ch: CharacteristicId): Promise<Uint8Array> {
		try {
			return copyBytes(await (await this.#characteristic(ch)).readValue());
		} catch (e) {
			throw toLinkError(e);
		}
	}

	async write(ch: CharacteristicId, data: Uint8Array): Promise<void> {
		try {
			await (await this.#characteristic(ch)).writeValueWithResponse(new Uint8Array(data));
		} catch (e) {
			throw toLinkError(e);
		}
	}

	async subscribe(ch: CharacteristicId, listener: (data: Uint8Array) => void): Promise<() => Promise<void>> {
		let c: BluetoothRemoteGATTCharacteristic;
		try {
			c = await this.#characteristic(ch);
		} catch (e) {
			throw toLinkError(e);
		}
		const handler = (ev: Event) => {
			const value = (ev.target as BluetoothRemoteGATTCharacteristic).value;
			if (value) listener(copyBytes(value));
		};
		c.addEventListener('characteristicvaluechanged', handler);
		try {
			await c.startNotifications();
		} catch (e) {
			c.removeEventListener('characteristicvaluechanged', handler);
			throw toLinkError(e);
		}
		return async () => {
			c.removeEventListener('characteristicvaluechanged', handler);
			if (!this.connected) return;
			try {
				await c.stopNotifications();
			} catch (e) {
				throw toLinkError(e);
			}
		};
	}

	onDisconnect(listener: () => void): Unsubscribe {
		this.#listeners.add(listener);
		return () => this.#listeners.delete(listener);
	}

	async #characteristic(ch: CharacteristicId): Promise<BluetoothRemoteGATTCharacteristic> {
		const known = this.#chars.get(ch);
		if (known) return known;
		if (!this.#server || !this.connected) throw new LinkError('disconnected', 'not connected');
		if (!DEVICE_INFO_CHARACTERISTICS.has(ch)) throw new LinkError('other', `characteristic ${ch} not found`);
		// Device Information is fetched on first use: it is optional, and may be blocklisted.
		const service = await this.#server.getPrimaryService(DEVICE_INFORMATION_SERVICE);
		const c = await service.getCharacteristic(CHARACTERISTICS[ch]);
		this.#chars.set(ch, c);
		return c;
	}
}
