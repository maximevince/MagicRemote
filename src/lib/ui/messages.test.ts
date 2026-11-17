import { describe, expect, it } from 'vitest';
import type { Os } from '../platform/detect.ts';
import { disconnectNote, failureText, staleBondHostCauses } from './messages.ts';

const ALL: Os[] = ['windows', 'macos', 'linux', 'chromeos', 'android', 'ios', 'other'];

describe('bond-stale text', () => {
	it('states what is known and does not blame the camera', () => {
		for (const os of ALL) {
			const t = failureText({ kind: 'bond-stale', step: 'pairing' }, os);
			expect(t.body).toContain('could not be set up with the stored pairing');
			expect(`${t.title} ${t.body}`).not.toMatch(/no longer accepts/i);
			expect(`${t.title} ${t.body}`).not.toContain('!');
		}
	});

	it('names the extra adapter and bluetoothctl pairing as host causes on Linux', () => {
		const causes = staleBondHostCauses('linux');
		expect(causes).toHaveLength(2);
		expect(causes[0]).toMatch(/more than one Bluetooth adapter/i);
		expect(causes[1]).toContain('bluetoothctl');
		expect(causes[1]).toContain('<camera address>');
	});

	it('gives at least one host cause everywhere, and no Linux advice elsewhere', () => {
		for (const os of ALL) {
			const causes = staleBondHostCauses(os);
			expect(causes.length).toBeGreaterThan(0);
			for (const c of causes) expect(c).not.toContain('!');
			if (os !== 'linux') expect(causes.join(' ')).not.toMatch(/bluetoothctl|adapter/);
		}
	});
});

describe('disconnect note', () => {
	it('explains on Linux that the link may stay open and how to free the camera', () => {
		const note = disconnectNote('linux');
		expect(note).toMatch(/keep the Bluetooth link/);
		expect(note).toContain('bluetoothctl disconnect <camera address>');
		expect(note).toMatch(/quit the browser/);
	});

	it('is not shown on other systems', () => {
		for (const os of ALL.filter((o) => o !== 'linux')) expect(disconnectNote(os)).toBeNull();
	});
});
