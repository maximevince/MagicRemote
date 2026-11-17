import { describe, expect, it, vi } from 'vitest';
import { UpdateController, type ContainerLike, type RegistrationLike, type WorkerLike } from './updates.svelte.ts';
import { SW_MESSAGE, type SwReply, type SwRequest } from './sw-messages.ts';

class FakeWorker extends EventTarget implements WorkerLike {
	state: ServiceWorkerState = 'installing';
	posted: SwRequest[] = [];
	postMessage(message: SwRequest) {
		this.posted.push(message);
	}
	to(state: ServiceWorkerState) {
		this.state = state;
		this.dispatchEvent(new Event('statechange'));
	}
}

class FakeRegistration extends EventTarget implements RegistrationLike {
	installing: FakeWorker | null = null;
	waiting: FakeWorker | null = null;
	active: FakeWorker | null = null;
	updates = 0;
	async update() {
		this.updates++;
	}
	/** A new worker starts installing. */
	found(): FakeWorker {
		const w = new FakeWorker();
		this.installing = w;
		this.dispatchEvent(new Event('updatefound'));
		return w;
	}
	installed(w: FakeWorker) {
		this.installing = null;
		this.waiting = w;
		w.to('installed');
	}
	activated(w: FakeWorker) {
		this.waiting = null;
		this.installing = null;
		this.active = w;
		w.to('activating');
		w.to('activated');
	}
}

class FakeContainer extends EventTarget implements ContainerLike {
	controller: FakeWorker | null = null;
	reg = new FakeRegistration();
	registered: string[] = [];
	unregistered = 0;
	failRegister = false;
	async register(url: string) {
		this.registered.push(url);
		if (this.failRegister) throw new Error('nope');
		return this.reg;
	}
	async getRegistrations() {
		return [{ unregister: async () => (this.unregistered++, true) }];
	}
	takeOver(w: FakeWorker) {
		this.controller = w;
		this.dispatchEvent(new Event('controllerchange'));
	}
	reply(data: SwReply) {
		this.dispatchEvent(new MessageEvent('message', { data }));
	}
}

/** A page already controlled by version 1. */
function returningVisit() {
	const c = new FakeContainer();
	const v1 = new FakeWorker();
	v1.state = 'activated';
	c.reg.active = v1;
	c.controller = v1;
	return c;
}

async function started(container: FakeContainer, dev = false) {
	const reload = vi.fn();
	const u = new UpdateController();
	await u.start({ container, scriptUrl: '/base/service-worker.js', dev, reload, checkEveryMs: 0 });
	return { u, reload };
}

describe('UpdateController', () => {
	it('does nothing without service worker support', async () => {
		const { u } = await started(undefined as unknown as FakeContainer);
		expect(u.phase).toBe('off');
		expect(u.apply()).toBe(false);
	});

	it('never registers on the dev server, and removes leftover workers', async () => {
		const c = new FakeContainer();
		const { u } = await started(c, true);
		expect(c.registered).toEqual([]);
		expect(c.unregistered).toBe(1);
		expect(u.phase).toBe('off');
	});

	it('registers the worker as a module at the given URL', async () => {
		const c = new FakeContainer();
		await started(c);
		expect(c.registered).toEqual(['/base/service-worker.js']);
	});

	it('reports a failed registration without throwing', async () => {
		const c = new FakeContainer();
		c.failRegister = true;
		const { u } = await started(c);
		expect(u.phase).toBe('error');
	});

	it('first visit: installing, then ready offline, without reloading on claim', async () => {
		const c = new FakeContainer();
		const { u, reload } = await started(c);
		expect(u.phase).toBe('installing');
		const w = c.reg.found();
		c.reg.installed(w);
		expect(u.waiting).toBe(false); // a first install is not an update
		c.reg.activated(w);
		c.takeOver(w); // clients.claim()
		expect(u.phase).toBe('ready');
		expect(u.offlineReadyNow).toBe(true);
		expect(u.offerUpdate).toBe(false);
		expect(reload).not.toHaveBeenCalled();
	});

	it('first install already running at registration time', async () => {
		const c = new FakeContainer();
		const w = new FakeWorker();
		c.reg.installing = w;
		const { u } = await started(c);
		expect(u.phase).toBe('installing');
		c.reg.installed(w);
		c.reg.activated(w);
		expect(u.phase).toBe('ready');
		expect(u.waiting).toBe(false);
	});

	it('a failed first install goes back to off', async () => {
		const c = new FakeContainer();
		const { u } = await started(c);
		c.reg.found().to('redundant');
		expect(u.phase).toBe('off');
	});

	it('returning visit is ready straight away', async () => {
		const { u } = await started(returningVisit());
		expect(u.phase).toBe('ready');
		expect(u.offlineReadyNow).toBe(false);
	});

	it('a new version waits and is offered, never applied by itself', async () => {
		const c = returningVisit();
		const { u, reload } = await started(c);
		const v2 = c.reg.found();
		expect(u.offerUpdate).toBe(false);
		c.reg.installed(v2);
		expect(u.waiting).toBe(true);
		expect(u.offerUpdate).toBe(true);
		expect(v2.posted).toEqual([]);
		expect(reload).not.toHaveBeenCalled();
	});

	it('offers a version that was already waiting from an earlier visit', async () => {
		const c = returningVisit();
		const v2 = new FakeWorker();
		v2.state = 'installed';
		c.reg.waiting = v2;
		const { u } = await started(c);
		expect(u.offerUpdate).toBe(true);
	});

	it('apply: asks the waiting worker to activate, reloads once it has taken over', async () => {
		const c = returningVisit();
		const { u, reload } = await started(c);
		const v2 = c.reg.found();
		c.reg.installed(v2);

		expect(u.apply()).toBe(true);
		expect(u.applying).toBe(true);
		expect(v2.posted).toEqual([{ type: SW_MESSAGE.skipWaiting }]);
		expect(reload).not.toHaveBeenCalled(); // not before the new worker controls the page

		c.reg.activated(v2);
		c.takeOver(v2);
		c.takeOver(v2);
		expect(reload).toHaveBeenCalledTimes(1);
	});

	it('a controller change the user did not ask for never reloads', async () => {
		const c = returningVisit();
		const { reload } = await started(c);
		const v2 = c.reg.found();
		c.reg.installed(v2);
		c.reg.activated(v2);
		c.takeOver(v2);
		expect(reload).not.toHaveBeenCalled();
	});

	it('while held (camera connected) the update is hidden and cannot be applied', async () => {
		const c = returningVisit();
		const { u, reload } = await started(c);
		const release = u.hold('camera connected');
		const v2 = c.reg.found();
		c.reg.installed(v2);

		expect(u.waiting).toBe(true);
		expect(u.offerUpdate).toBe(false);
		expect(u.apply()).toBe(false);
		expect(u.refused).toBe('held');
		expect(v2.posted).toEqual([]);
		expect(reload).not.toHaveBeenCalled();

		release();
		release(); // idempotent
		expect(u.held).toBe(false);
		expect(u.offerUpdate).toBe(true);
		expect(u.apply()).toBe(true);
	});

	it('holds are counted: every holder must release', async () => {
		const { u } = await started(returningVisit());
		const a = u.hold('camera A');
		const b = u.hold('camera A');
		a();
		expect(u.held).toBe(true);
		b();
		expect(u.held).toBe(false);
	});

	it('the worker refusing (other windows open) cancels the apply without reloading', async () => {
		const c = returningVisit();
		const { u, reload } = await started(c);
		const v2 = c.reg.found();
		c.reg.installed(v2);
		u.apply();
		c.reply({ type: SW_MESSAGE.refused, reason: 'other-windows' });
		expect(u.applying).toBe(false);
		expect(u.refused).toBe('other-windows');
		expect(u.offerUpdate).toBe(true);
		c.takeOver(v2); // e.g. the other window closed and the version activated anyway
		expect(reload).not.toHaveBeenCalled();
	});

	it('a version activated by something else stops being offered', async () => {
		const c = returningVisit();
		const { u } = await started(c);
		const v2 = c.reg.found();
		c.reg.installed(v2);
		c.reg.activated(v2);
		expect(u.offerUpdate).toBe(false);
		expect(u.apply()).toBe(false);
	});

	it('a replaced waiting version stops being offered', async () => {
		const c = returningVisit();
		const { u } = await started(c);
		const v2 = c.reg.found();
		c.reg.installed(v2);
		c.reg.waiting = null;
		v2.to('redundant');
		expect(u.waiting).toBe(false);
	});

	it('check() asks the registration for an update and swallows offline errors', async () => {
		const c = returningVisit();
		const { u } = await started(c);
		await u.check();
		expect(c.reg.updates).toBe(1);
		c.reg.update = () => Promise.reject(new TypeError('offline'));
		await expect(u.check()).resolves.toBeUndefined();
	});

	it('start() runs once', async () => {
		const c = returningVisit();
		const { u } = await started(c);
		await u.start({ container: c, scriptUrl: '/x.js', dev: false, reload: () => {}, checkEveryMs: 0 });
		expect(c.registered).toEqual(['/base/service-worker.js']);
	});
});
