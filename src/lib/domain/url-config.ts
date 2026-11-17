import type { RecordRecipe } from '../protocol/index.ts';
import type { SessionConfig } from './camera-session.svelte.ts';
import type { RecordConfig } from './record-controller.svelte.ts';

/**
 * Overrides for the settings that still depend on hardware tests (M0), so they can be tried
 * from the browser without a rebuild:
 *   ?primary=A&retry=B   record recipes (A, A-prime, B)
 *   ?burst=none          do not resync again when the camera state does not arrive while connecting
 *   ?resync=0            do not write Camera Status 0x01 (resync) on connect (alias: ?poweron=0)
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
	if (burst === 'none' || burst === 'resync') config.burstMissing = burst;
	const resync = q.get('resync') ?? q.get('poweron');
	if (resync === '0' || resync === '1') config.resyncOnConnect = resync === '1';
	const name = q.get('name');
	if (name) config.deviceName = name;
	return config;
}
