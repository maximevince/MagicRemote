import type { RecordRecipe } from '../protocol/index.ts';
import type { SessionConfig } from './camera-session.svelte.ts';
import type { RecordConfig } from './record-controller.svelte.ts';

/**
 * Overrides for the settings that still depend on hardware tests (M0), so they can be tried
 * from the browser without a rebuild:
 *   ?primary=A&retry=B   record recipes (A, A-prime, B)
 *   ?burst=none          do not resubscribe when the initial burst is missing
 *   ?poweron=0           do not write Camera Status 0x01 after the first pairing
 *   ?name=Cam%20Op       our name as shown on the camera
 */
const RECIPES: readonly RecordRecipe[] = ['A', 'A-prime', 'B'];

export function sessionConfigFromQuery(q: URLSearchParams): Partial<SessionConfig> {
	const config: Partial<SessionConfig> = {};
	const record: Partial<RecordConfig> = {};
	const primary = q.get('primary') as RecordRecipe | null;
	const retry = q.get('retry') as RecordRecipe | null;
	if (primary && RECIPES.includes(primary)) record.primary = primary;
	if (retry && RECIPES.includes(retry)) record.retry = retry;
	if (Object.keys(record).length) config.record = record;
	const burst = q.get('burst');
	if (burst === 'none' || burst === 'resubscribe') config.burstMissing = burst;
	const poweron = q.get('poweron');
	if (poweron === '0' || poweron === '1') config.powerOnAfterFirstPairing = poweron === '1';
	const name = q.get('name');
	if (name) config.deviceName = name;
	return config;
}
