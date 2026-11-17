// Service worker registration and the update prompt.
//
// Rules: a new version never reloads or takes over a live session.
// A new worker installs in the background and waits. The page offers "Update available — reload",
// hidden while anything holds updates (a connected camera), and only on that press does it ask the
// waiting worker to activate, then reloads once it has taken over.
import { untrack } from 'svelte';
import { SW_MESSAGE, isSwReply, type SwRefusal, type SwRequest } from './sw-messages.ts';

/** The parts of the ServiceWorker APIs this module uses, so tests can fake them. */
export interface WorkerLike extends EventTarget {
	readonly state: ServiceWorkerState;
	postMessage(message: SwRequest): void;
}

export interface RegistrationLike extends EventTarget {
	readonly installing: WorkerLike | null;
	readonly waiting: WorkerLike | null;
	readonly active: WorkerLike | null;
	update(): Promise<unknown>;
}

export interface ContainerLike extends EventTarget {
	readonly controller: WorkerLike | null;
	register(url: string, options?: RegistrationOptions): Promise<RegistrationLike>;
	getRegistrations(): Promise<readonly { unregister(): Promise<boolean> }[]>;
}

export interface UpdateDeps {
	container: ContainerLike | undefined;
	/** URL of the built worker, e.g. `${base}/service-worker.js`. */
	scriptUrl: string;
	/** Dev server: never run a worker there; remove any left over from a preview build. */
	dev: boolean;
	reload: () => void;
	/** How often to look for a new version while the page stays open. 0 disables. */
	checkEveryMs?: number;
}

export type UpdatePhase =
	| 'off' // not started, dev, or no service worker support
	| 'installing' // first visit, precaching
	| 'ready' // running from the cache, works offline
	| 'error'; // registration failed; the app still works online

const HOUR = 60 * 60 * 1000;

export class UpdateController {
	phase = $state<UpdatePhase>('off');
	/** Set once, when the first install finishes in this window; the UI may say "ready offline". */
	offlineReadyNow = $state(false);
	/** A new version is installed and waiting. */
	waiting = $state(false);
	/** The user pressed reload; waiting for the new worker to take over. */
	applying = $state(false);
	/** Why the last apply() did not go through. */
	refused = $state<SwRefusal | 'held' | null>(null);
	#holds = $state(new Set<string>());

	/** Holders (e.g. "camera connected"); while any exist the update is neither offered nor applied. */
	get held(): boolean {
		return this.#holds.size > 0;
	}

	/** Show the "Update available" affordance. */
	get offerUpdate(): boolean {
		return this.waiting && !this.held;
	}

	#deps: UpdateDeps | null = null;
	#reg: RegistrationLike | null = null;
	#reloaded = false;
	#cleanup: (() => void)[] = [];
	#nextHold = 0;

	/**
	 * Keep updates away while the returned function hasn't been called. Use it for the whole time a
	 * camera is connected; recording implies connected.
	 */
	hold(reason: string): () => void {
		const key = `${reason}#${this.#nextHold++}`;
		// Callers hold from an effect; reading the set there must not make that effect depend on it.
		untrack(() => {
			this.#holds = new Set(this.#holds).add(key);
			this.refused = null;
		});
		return () =>
			untrack(() => {
				if (!this.#holds.has(key)) return;
				const next = new Set(this.#holds);
				next.delete(key);
				this.#holds = next;
			});
	}

	async start(deps: UpdateDeps): Promise<void> {
		if (this.#deps) return;
		this.#deps = deps;
		const { container, dev } = deps;
		if (!container) return;
		if (dev) {
			// A worker from an earlier `vite preview` on this origin would serve stale files.
			for (const r of await container.getRegistrations().catch(() => [])) await r.unregister().catch(() => false);
			return;
		}

		const listen = (target: EventTarget, type: string, fn: (e: Event) => void) => {
			target.addEventListener(type, fn);
			this.#cleanup.push(() => target.removeEventListener(type, fn));
		};

		listen(container, 'controllerchange', () => {
			// Only the worker we asked to take over may reload the page. A first install claiming the
			// page also fires this, and must not reload anything.
			if (!this.applying || this.#reloaded) return;
			this.#reloaded = true;
			deps.reload();
		});
		listen(container, 'message', (e) => {
			const data = (e as MessageEvent).data;
			if (!isSwReply(data)) return;
			this.applying = false;
			this.refused = data.reason;
		});

		const hadController = !!container.controller;
		let reg: RegistrationLike;
		try {
			reg = await container.register(deps.scriptUrl, { type: 'module' });
		} catch {
			this.phase = 'error';
			return;
		}
		this.#reg = reg;

		// With a worker already active, whatever installs next is an update.
		const updating = hadController || !!reg.active;
		this.phase = updating ? 'ready' : 'installing';
		// A version may already be waiting from an earlier visit.
		if (reg.waiting && updating) this.#track(reg.waiting, true);
		if (reg.installing) this.#track(reg.installing, updating);

		listen(reg, 'updatefound', () => {
			if (reg.installing) this.#track(reg.installing, !!reg.active);
		});

		const every = deps.checkEveryMs ?? HOUR;
		if (every > 0) {
			const id = setInterval(() => this.check(), every);
			this.#cleanup.push(() => clearInterval(id));
		}
	}

	/** Look for a new version. Harmless at any time: a new worker only installs and waits. */
	async check(): Promise<void> {
		await this.#reg?.update().catch(() => undefined);
	}

	/**
	 * User pressed "reload". Returns false if nothing was done. Never call this from anything but
	 * a user action.
	 */
	apply(): boolean {
		const worker = this.#reg?.waiting;
		if (!worker || this.applying) return false;
		if (this.held) {
			this.refused = 'held';
			return false;
		}
		this.refused = null;
		this.applying = true;
		worker.postMessage({ type: SW_MESSAGE.skipWaiting });
		return true;
	}

	/** Detach all listeners (tests). */
	stop(): void {
		for (const fn of this.#cleanup.splice(0)) fn();
	}

	#track(worker: WorkerLike, isUpdate: boolean): void {
		if (!isUpdate) this.phase = 'installing';
		const onState = () => {
			if (worker.state === 'installed') {
				if (isUpdate) this.waiting = true;
			} else if (worker.state === 'activating' || worker.state === 'activated') {
				// Activated without us (every other window closed first): nothing left to offer.
				if (isUpdate) this.waiting = this.#reg?.waiting != null && this.#reg.waiting !== worker;
				if (worker.state === 'activating') return;
				if (!isUpdate) {
					this.phase = 'ready';
					this.offlineReadyNow = true;
				}
				worker.removeEventListener('statechange', onState);
			} else if (worker.state === 'redundant') {
				// Install failed (e.g. went offline mid-precache), or a newer version replaced it.
				if (!isUpdate && this.phase === 'installing') this.phase = 'off';
				if (isUpdate && this.#reg?.waiting == null) this.waiting = false;
				worker.removeEventListener('statechange', onState);
			}
		};
		worker.addEventListener('statechange', onState);
		this.#cleanup.push(() => worker.removeEventListener('statechange', onState));
		onState();
	}
}

/**
 * The app-wide controller. The root layout starts it; the camera page holds it while connected:
 *
 *     $effect(() => (connected ? updates.hold('camera connected') : undefined));
 */
export const updates = new UpdateController();
