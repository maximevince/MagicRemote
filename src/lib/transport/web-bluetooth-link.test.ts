import { describe, expect, it, vi } from 'vitest';
import { CAMERA_SERVICE, CHARACTERISTICS, DEVICE_INFORMATION_SERVICE, LinkError } from './link.ts';
import { requestCameraLink, toLinkError, WebBluetoothLink } from './web-bluetooth-link.ts';

/**
 * Checks the mapping onto a hand-written stand-in for the Web Bluetooth objects. This does not
 * show that the real browser stack behaves like the stand-in.
 */

class FakeChar extends EventTarget {
	value: DataView | undefined;
	readonly written: Uint8Array[] = [];
	notifying = false;
	constructor(
		readonly uuid: string,
		private readonly data = new Uint8Array(0)
	) {
		super();
	}
	async readValue() {
		return new DataView(this.data.buffer);
	}
	async writeValueWithResponse(d: Uint8Array) {
		this.written.push(new Uint8Array(d));
	}
	async startNotifications() {
		this.notifying = true;
		return this;
	}
	async stopNotifications() {
		this.notifying = false;
		return this;
	}
	/** Emit a value backed by a larger, reused buffer, as browsers may do. */
	notify(bytes: number[]) {
		const buf = new Uint8Array(64);
		buf.set(bytes, 8);
		this.value = new DataView(buf.buffer, 8, bytes.length);
		this.dispatchEvent(new Event('characteristicvaluechanged'));
		buf.fill(0xee);
	}
}

function fakeDevice() {
	const chars = Object.fromEntries(
		Object.entries(CHARACTERISTICS)
			.filter(([, u]) => typeof u === 'string')
			.map(([k, u]) => [k, new FakeChar(u as string)])
	) as Record<string, FakeChar>;
	const model = new FakeChar('00002a24-0000-1000-8000-00805f9b34fb', new TextEncoder().encode('Pocket\0\0'));
	const device = new EventTarget() as EventTarget & { id: string; name: string; gatt: unknown };
	const server = {
		connected: false,
		connect: vi.fn(async () => {
			server.connected = true;
			return server;
		}),
		disconnect: vi.fn(() => {
			server.connected = false;
			device.dispatchEvent(new Event('gattserverdisconnected'));
		}),
		getPrimaryService: vi.fn(async (uuid: string | number) => {
			if (uuid === CAMERA_SERVICE) return { getCharacteristics: async () => Object.values(chars) };
			if (uuid === DEVICE_INFORMATION_SERVICE) return { getCharacteristic: async () => model };
			throw new DOMException('No Services matching UUID found in Device.', 'NotFoundError');
		})
	};
	Object.assign(device, { id: 'dev1', name: 'A:1A2B3C4D', gatt: server });
	return { device: device as unknown as BluetoothDevice, server, chars, model };
}

describe('WebBluetoothLink', () => {
	it('connects, finds the characteristics and writes with response', async () => {
		const f = fakeDevice();
		const link = new WebBluetoothLink(f.device);
		expect(link.name).toBe('A:1A2B3C4D');
		await link.connect();
		expect(link.connected).toBe(true);
		await link.write('outgoing', new Uint8Array([1, 2, 3]));
		expect(f.chars.outgoing.written).toEqual([new Uint8Array([1, 2, 3])]);
		expect(await link.read('model')).toEqual(new TextEncoder().encode('Pocket\0\0'));
	});

	it('delivers a copy of each notification and stops on unsubscribe', async () => {
		const f = fakeDevice();
		const link = new WebBluetoothLink(f.device);
		await link.connect();
		const got: Uint8Array[] = [];
		const unsub = await link.subscribe('incoming', (b) => got.push(b));
		expect(f.chars.incoming.notifying).toBe(true);
		f.chars.incoming.notify([0xff, 4, 0, 0]);
		expect(got).toEqual([new Uint8Array([0xff, 4, 0, 0])]);
		await unsub();
		expect(f.chars.incoming.notifying).toBe(false);
		f.chars.incoming.notify([1]);
		expect(got).toHaveLength(1);
	});

	it('reports disconnects and throws away the handles', async () => {
		const f = fakeDevice();
		const link = new WebBluetoothLink(f.device);
		const down = vi.fn();
		link.onDisconnect(down);
		await link.connect();
		f.server.disconnect();
		expect(down).toHaveBeenCalledOnce();
		await expect(link.write('outgoing', new Uint8Array([1]))).rejects.toMatchObject({ kind: 'disconnected' });
		await link.connect();
		await link.write('outgoing', new Uint8Array([1]));
		expect(f.server.getPrimaryService).toHaveBeenCalledTimes(2);
	});

	it('maps a failed subscription to an auth error and removes its listener', async () => {
		const f = fakeDevice();
		f.chars.status.startNotifications = async () => {
			throw new DOMException('Authentication canceled.', 'NetworkError');
		};
		const link = new WebBluetoothLink(f.device);
		await link.connect();
		const listener = vi.fn();
		await expect(link.subscribe('status', listener)).rejects.toMatchObject({ kind: 'auth' });
		f.chars.status.notify([3]);
		expect(listener).not.toHaveBeenCalled();
	});

	it('asks the chooser for the camera service only, with Device Information as optional', async () => {
		const f = fakeDevice();
		const requestDevice = vi.fn(async () => f.device);
		const bt = { requestDevice } as unknown as Bluetooth;
		await requestCameraLink(bt);
		expect(requestDevice).toHaveBeenCalledWith({
			filters: [{ services: [CAMERA_SERVICE] }],
			optionalServices: [DEVICE_INFORMATION_SERVICE]
		});
		await requestCameraLink(bt, { name: 'A:1A2B3C4D' });
		expect(requestDevice).toHaveBeenLastCalledWith(
			expect.objectContaining({ filters: [{ services: [CAMERA_SERVICE], name: 'A:1A2B3C4D' }] })
		);
		requestDevice.mockRejectedValueOnce(new DOMException('User cancelled the requestDevice() chooser.', 'NotFoundError'));
		await expect(requestCameraLink(bt)).rejects.toMatchObject({ kind: 'cancelled' });
	});
});

describe('toLinkError', () => {
	it.each([
		['NetworkError', 'Authentication failed.', 'auth'],
		['NetworkError', 'Authentication canceled.', 'auth'],
		['SecurityError', 'GATT operation not authorized.', 'auth'],
		['NetworkError', 'GATT Error: Not paired.', 'auth'],
		['NetworkError', 'GATT Server is disconnected. Cannot perform GATT operations.', 'disconnected'],
		['NetworkError', 'Connection failed for unknown reason.', 'disconnected'],
		['NotFoundError', 'User cancelled the requestDevice() chooser.', 'cancelled'],
		['NotFoundError', 'Bluetooth adapter not available.', 'not-found'],
		['SecurityError', 'Origin is not allowed to access the service.', 'unsupported'],
		['NotSupportedError', 'GATT Error Unknown.', 'other']
	])('%s "%s" → %s', (name, msg, kind) => {
		expect(toLinkError(new DOMException(msg, name)).kind).toBe(kind);
	});

	it('passes LinkErrors through', () => {
		const e = new LinkError('auth', 'x');
		expect(toLinkError(e)).toBe(e);
	});
});
