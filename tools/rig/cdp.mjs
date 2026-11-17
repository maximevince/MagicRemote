#!/usr/bin/env node
// Drive the Chromium on the rig over the DevTools protocol (port forwarded to localhost).
//   cdp.mjs shot out.png [WxH]      screenshot of the app page, optionally at another viewport size
//   cdp.mjs text                    visible text of the page
//   cdp.mjs eval '<js expression>'  evaluate in the page, print the JSON result
//   cdp.mjs click '<button text>'   real mouse click on the first button whose text contains it
//   cdp.mjs connect '<button text>' [device-name-substring]
//                                   click, then pick the camera in the Bluetooth chooser
//   cdp.mjs reload
// Needs Node 22+ (built-in WebSocket and fetch). Port: $CDP_PORT, default 9222.
import { writeFileSync } from 'node:fs';

const port = process.env.CDP_PORT ?? '9222';
const [cmd, arg, arg2] = process.argv.slice(2);

const targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
const page = targets.find((t) => t.type === 'page' && t.url.includes('localhost:4173')) ?? targets.find((t) => t.type === 'page');
if (!page) throw new Error('no page target');

const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((ok, bad) => { ws.onopen = ok; ws.onerror = () => bad(new Error('cannot open DevTools socket')); });
let seq = 0;
const pending = new Map();
const listeners = [];
ws.onmessage = (ev) => {
	const m = JSON.parse(ev.data);
	if (m.id && pending.has(m.id)) {
		const { ok, bad } = pending.get(m.id);
		pending.delete(m.id);
		m.error ? bad(new Error(m.error.message)) : ok(m.result);
	} else if (m.method) listeners.forEach((l) => l(m));
};
const send = (method, params = {}) => new Promise((ok, bad) => { const id = ++seq; pending.set(id, { ok, bad }); ws.send(JSON.stringify({ id, method, params })); });
const evaluate = async (expression) => {
	const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
	if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
	return r.result.value;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// A "leave site?" prompt (the app guards against dropping a live link) blocks every other command:
// accept one that is already open, and any that a reload opens.
listeners.push((m) => {
	if (m.method === 'Page.javascriptDialogOpening') void send('Page.handleJavaScriptDialog', { accept: true }).catch(() => {});
});
await send('Page.enable');
await Promise.race([send('Page.handleJavaScriptDialog', { accept: true }).catch(() => {}), sleep(500)]);

async function click(label) {
	const pos = await evaluate(`(() => {
		const b = [...document.querySelectorAll('button')].find((b) => b.textContent.trim().includes(${JSON.stringify(label)}) && !b.disabled);
		if (!b) return null;
		const r = b.getBoundingClientRect();
		return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
	})()`);
	if (!pos) throw new Error(`no enabled button containing "${label}"`);
	for (const type of ['mousePressed', 'mouseReleased'])
		await send('Input.dispatchMouseEvent', { type, x: pos.x, y: pos.y, button: 'left', clickCount: 1 });
}

if (cmd === 'shot') {
	if (arg2) {
		// Lay the page out at another viewport size for this screenshot only.
		const [width, height] = arg2.split('x').map(Number);
		await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });
		await new Promise((r) => setTimeout(r, 300));
	}
	const { data } = await send('Page.captureScreenshot', { format: 'png' });
	writeFileSync(arg, Buffer.from(data, 'base64'));
	console.log(`wrote ${arg}`);
} else if (cmd === 'text') {
	console.log(await evaluate('document.body.innerText'));
} else if (cmd === 'eval') {
	console.log(JSON.stringify(await evaluate(arg), null, 1));
} else if (cmd === 'click') {
	await click(arg);
	console.log(`clicked "${arg}"`);
} else if (cmd === 'reload') {
	await send('Page.reload', { ignoreCache: true });
	console.log('reloaded');
} else if (cmd === 'connect') {
	await send('DeviceAccess.enable');
	const want = arg2 ?? '';
	const picked = new Promise((ok, bad) => {
		const timer = setTimeout(() => bad(new Error('chooser: camera not listed within 40 s')), 40000);
		// The prompt event repeats as the list updates. Answer it exactly once: a second
		// selectPrompt for the same chooser crashes Chromium (CHECK in the chooser controller).
		let answered = false;
		listeners.push(async (m) => {
			if (m.method !== 'DeviceAccess.deviceRequestPrompted' || answered) return;
			const dev = m.params.devices.find((d) => d.name.includes(want));
			console.log('chooser lists:', m.params.devices.map((d) => d.name).join(', ') || '(nothing yet)');
			if (!dev) return;
			answered = true;
			clearTimeout(timer);
			await send('DeviceAccess.selectPrompt', { id: m.params.id, deviceId: dev.id });
			ok(dev.name);
		});
	});
	await click(arg);
	console.log(`picked ${await picked}`);
	await sleep(500);
} else {
	console.error('usage: cdp.mjs shot <file> | text | eval <js> | click <label> | connect <label> [name] | reload');
	process.exitCode = 2;
}
ws.close();
