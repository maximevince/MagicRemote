import type { Os } from '../platform/detect.ts';
import type { HandshakeStep, SessionFailure, SessionPhase } from '../domain/camera-session.svelte.ts';
import type { RecordError, RecordNotice } from '../domain/record-controller.svelte.ts';

export const LINUX_PAIRING =
	'In a terminal: bluetoothctl, then agent KeyboardOnly, default-agent, scan on, and pair <camera address>. Type the PIN the camera shows within about 30 seconds. GNOME Settings cannot pair this camera.';

export const LINUX_FLAG = 'chrome://flags/#enable-experimental-web-platform-features';

/** What happens when the PIN is due, per OS. */
export function pinHint(os: Os): string {
	switch (os) {
		case 'linux':
		case 'chromeos':
			return `Chrome on Linux cannot take the PIN. Pair once outside the browser first. ${LINUX_PAIRING} Then connect here.`;
		case 'windows':
			return 'Chrome will open a dialog asking for the PIN. If it does not, pair the camera in Windows Settings > Bluetooth & devices first.';
		case 'macos':
			return 'macOS will show its own pairing dialog asking for the PIN.';
		case 'android':
			return 'Android will show its own pairing dialog asking for the PIN.';
		default:
			return 'Your system will ask for the PIN in a pairing dialog.';
	}
}

export function hostBondRemoval(os: Os): string {
	switch (os) {
		case 'linux':
		case 'chromeos':
			return 'On this computer: bluetoothctl, then remove <camera address>.';
		case 'windows':
			return 'On this computer: Settings > Bluetooth & devices, open the camera, Remove device.';
		case 'macos':
			return 'On this Mac: System Settings > Bluetooth, the camera’s (i) button, Forget This Device.';
		case 'android':
			return 'On this phone: Settings > Connected devices, the camera’s gear icon, Forget.';
		default:
			return 'Remove the camera from this device’s Bluetooth settings.';
	}
}

/**
 * Causes on this device's side for an encryption failure with a stored pairing, cheapest to fix
 * first. The browser only reports that the secure link failed, not which side lost the key.
 */
export function staleBondHostCauses(os: Os): string[] {
	switch (os) {
		case 'linux':
			return [
				'More than one Bluetooth adapter: the browser may use one that is not paired with the camera. bluetoothctl list shows them. Unplug or disable the extra one, then try again.',
				`This computer is not paired with the camera yet. Chrome on Linux cannot pair, so pair once outside the browser. ${LINUX_PAIRING}`
			];
		case 'chromeos':
			return ['This Chromebook may no longer hold the pairing, for example after the camera was removed from its Bluetooth settings.'];
		case 'windows':
			return ['This computer may no longer hold the pairing, for example after the camera was removed from its Bluetooth settings.'];
		case 'macos':
			return ['This Mac may no longer hold the pairing, for example after the camera was removed from its Bluetooth settings.'];
		case 'android':
			return ['This phone may no longer hold the pairing, for example after the camera was removed from its Bluetooth settings.'];
		default:
			return ['This device may no longer hold the pairing, for example after the camera was removed from its Bluetooth settings.'];
	}
}

/**
 * Shown after the user disconnected. Only where it is known that the OS keeps the Bluetooth link
 * up after the page lets go (Linux/BlueZ, measured); null elsewhere.
 */
export function disconnectNote(os: Os): string | null {
	if (os !== 'linux') return null;
	return 'This computer may keep the Bluetooth link to the camera open. The camera takes one controller at a time. To free it for another device, disconnect the camera in the system Bluetooth settings or with bluetoothctl disconnect <camera address>, or quit the browser.';
}

export const STEP_LABEL: Record<HandshakeStep, string> = {
	connecting: 'Connecting',
	identifying: 'Reading camera model',
	naming: 'Sending our name',
	pairing: 'Securing the link (PIN if this is the first time)',
	subscribing: 'Subscribing to camera reports',
	syncing: 'Receiving camera state'
};

export const PHASE_LABEL: Record<SessionPhase, string> = {
	idle: 'Not connected',
	choosing: 'Choosing camera',
	connecting: 'Connecting',
	identifying: 'Connecting',
	naming: 'Connecting',
	pairing: 'Pairing',
	subscribing: 'Connecting',
	syncing: 'Syncing',
	standby: 'Standby',
	ready: 'Connected',
	reconnecting: 'Reconnecting',
	'pairing-failed': 'Pairing failed',
	'bond-stale': 'Secure link failed',
	failed: 'Connection failed',
	disconnected: 'Disconnected'
};

export function failureText(f: SessionFailure, os: Os): { title: string; body: string } {
	const linux = os === 'linux' || os === 'chromeos';
	switch (f.kind) {
		case 'chooser-cancelled':
			return { title: 'No camera chosen', body: 'Tap Connect again when the camera is on and its Bluetooth is enabled.' };
		case 'bluetooth-unavailable':
			return { title: 'Bluetooth is off or missing', body: 'Turn on Bluetooth on this device and try again.' };
		case 'unsupported':
			return { title: 'Bluetooth is blocked here', body: 'This page is not allowed to use Bluetooth (it must be served over HTTPS, and not inside a frame).' };
		case 'connect-failed':
			return { title: 'Camera not found', body: 'Toggle Bluetooth on the camera, or wait a moment and try again. The camera stops advertising for a while after a failed pairing.' };
		case 'pairing-failed':
			return {
				title: 'Pairing did not complete',
				body: linux
					? `Chrome on Linux cannot take the PIN. ${LINUX_PAIRING} Then connect here.`
					: 'The PIN was wrong, the dialog was cancelled, or it timed out. Each try shows a new PIN on the camera. Get ready, then try again.'
			};
		case 'pairing-interrupted':
			return { title: 'Pairing timed out', body: 'The camera gives you about 30 seconds to type the PIN. Get ready, then try again; the camera will show a new PIN.' };
		case 'bond-stale':
			return {
				title: 'The stored pairing did not work',
				body: 'The secure link could not be set up with the stored pairing. The browser does not say why, so the cause can be on this device or on the camera. The app has stopped and will not pair again on its own.'
			};
		case 'unexpected':
			return { title: 'Something went wrong', body: f.detail ?? 'Unknown error.' };
	}
}

export function recordErrorText(e: RecordError): string {
	const what = e.intent === 'start' ? 'start recording' : 'stop recording';
	const last = e.lastMode === 2 ? 'recording' : e.lastMode === 1 ? 'playback' : e.lastMode === 0 ? 'not recording' : 'unknown';
	if (e.reason === 'write-failed') return `Could not send ${what}${e.detail ? ` (${e.detail})` : ''}. Camera last reported: ${last}.`;
	return `The camera did not confirm ${what}. Camera last reported: ${last}.`;
}

export function noticeText(n: RecordNotice): string {
	const slot = n.slot !== undefined ? `slot ${n.slot + 1}` : 'the active slot';
	switch (n.kind) {
		case 'no-media':
			return `No media ready in ${slot}. Recording was not started.`;
		case 'media-full':
			return `The media in ${slot} is full. Recording was not started.`;
		case 'media-unknown':
			return 'Media state unknown; sent anyway.';
		case 'interrupted':
			return 'The link dropped before the camera confirmed. Check the button once reconnected.';
	}
}
