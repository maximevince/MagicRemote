/**
 * Cameras this browser has bonded with. A known camera never pairs again
 * automatically: an auth failure on it means the bond is stale.
 * Keyed on the hardware ID suffix of the advertised name ("A:1A2B3C4D" → "1A2B3C4D"), because
 * the letter prefix follows the slate camera ID and Web Bluetooth device ids may not be stable.
 */

export interface KnownCamera {
	name: string;
	model: string | null;
	lastSeen: number;
}

export interface KnownCameraStore {
	has(key: string): boolean;
	remember(key: string, info: KnownCamera): void;
	forget(key: string): void;
}

export function cameraKey(advertisedName: string | undefined, fallbackId: string): string {
	if (!advertisedName) return `id:${fallbackId}`;
	const i = advertisedName.lastIndexOf(':');
	return i === -1 ? advertisedName : advertisedName.slice(i + 1);
}

export class MemoryKnownCameras implements KnownCameraStore {
	readonly map = new Map<string, KnownCamera>();
	has(key: string): boolean {
		return this.map.has(key);
	}
	remember(key: string, info: KnownCamera): void {
		this.map.set(key, info);
	}
	forget(key: string): void {
		this.map.delete(key);
	}
}

const STORAGE_KEY = 'magicremote.knownCameras';

/** localStorage-backed; every access may throw (private mode, quota), and is then ignored. */
export class LocalKnownCameras implements KnownCameraStore {
	#load(): Record<string, KnownCamera> {
		try {
			const raw = localStorage.getItem(STORAGE_KEY);
			const parsed: unknown = raw ? JSON.parse(raw) : {};
			return parsed && typeof parsed === 'object' ? (parsed as Record<string, KnownCamera>) : {};
		} catch {
			return {};
		}
	}

	#save(all: Record<string, KnownCamera>): void {
		try {
			localStorage.setItem(STORAGE_KEY, JSON.stringify(all));
		} catch {
			/* storage unavailable */
		}
	}

	has(key: string): boolean {
		return key in this.#load();
	}

	remember(key: string, info: KnownCamera): void {
		this.#save({ ...this.#load(), [key]: info });
	}

	forget(key: string): void {
		const all = this.#load();
		delete all[key];
		this.#save(all);
	}
}
