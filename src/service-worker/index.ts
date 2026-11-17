// Offline support. Precaches the whole app (it is small and fully prerendered) into a cache named
// after the build version and serves it cache-first. Update rules:
// a new worker never takes over by itself. It waits until every window is closed, or until the
// page asks it to (the user pressed "reload" and no camera is connected), see #lib/platform/updates.
import { self } from '$app/service-worker';
import { immutable, assets, prerendered } from '$app/manifest';
import { version } from '$app/env';
import { SW_MESSAGE, type SwReply, type SwRequest } from '#lib/platform/sw-messages.ts';

const PREFIX = 'magicremote-';
const CACHE = `${PREFIX}${version}`;

// Files GitHub Pages needs but the app never fetches.
const SKIP = new Set(['CNAME', 'robots.txt']);

// Manifest paths are relative to the base path, which is the worker's scope.
const scope = self.registration.scope; // always ends with '/'
const toUrl = (path: string) => new URL(path.replace(/^\//, ''), scope).href;

const PRECACHE = [
	...immutable.map((f) => f.path),
	...assets.map((f) => f.path).filter((p) => !SKIP.has(p.replace(/^\//, ''))),
	...prerendered.map((f) => f.path)
].map(toUrl);
const PRECACHED = new Set(PRECACHE);

// The single prerendered page. Its asset links are relative, so it only works served at its own
// URL: other navigations that fail offline are redirected there rather than given its content.
const SHELL = scope;

self.addEventListener('install', (event) => {
	event.waitUntil(
		(async () => {
			const cache = await caches.open(CACHE);
			// Bypass the HTTP cache so a stale page can't be paired with this version's assets.
			await cache.addAll(PRECACHE.map((url) => new Request(url, { cache: 'reload' })));
		})()
	);
	// No skipWaiting here: an open window keeps the version it was loaded with.
});

self.addEventListener('activate', (event) => {
	event.waitUntil(
		(async () => {
			// We only become active once no window uses the old worker, so its cache is free to go.
			for (const key of await caches.keys()) {
				if (key.startsWith(PREFIX) && key !== CACHE) await caches.delete(key);
			}
			// Control a first-visit page right away so it shows as offline-ready. This never swaps the
			// code of a running page: on an update there is no other window left to claim.
			await self.clients.claim();
		})()
	);
});

self.addEventListener('message', (event) => {
	const data = event.data as SwRequest | undefined;
	if (data?.type !== SW_MESSAGE.skipWaiting) return;
	event.waitUntil(
		(async () => {
			const source = event.source;
			const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
			// Another window may have a camera connected; activating now would pull its cache away.
			if (windows.length > 1) {
				const reply: SwReply = { type: SW_MESSAGE.refused, reason: 'other-windows' };
				source?.postMessage(reply);
				return;
			}
			await self.skipWaiting();
		})()
	);
});

self.addEventListener('fetch', (event) => {
	const request = event.request;
	if (request.method !== 'GET') return;
	const url = new URL(request.url);
	// Cross-origin and out-of-scope requests go straight to the network, untouched.
	if (url.origin !== self.location.origin || !url.href.startsWith(scope)) return;

	if (request.mode === 'navigate') {
		event.respondWith(navigate(request, url));
		return;
	}

	url.search = '';
	url.hash = '';
	if (PRECACHED.has(url.href)) event.respondWith(fromCache(request, url.href));
	// Anything else (not part of the build) is left to the network; nothing is cached at runtime.
});

async function fromCache(request: Request, key: string): Promise<Response> {
	const cache = await caches.open(CACHE);
	return (await cache.match(key)) ?? fetch(request);
}

async function navigate(request: Request, url: URL): Promise<Response> {
	const cache = await caches.open(CACHE);
	// Query strings (?sim=1 and friends) are read by the page, the document is the same.
	const hit = await cache.match(url.href, { ignoreSearch: true });
	if (hit) return hit;
	try {
		return await fetch(request);
	} catch (err) {
		if (await cache.match(SHELL)) return Response.redirect(SHELL + url.search, 302);
		throw err;
	}
}
