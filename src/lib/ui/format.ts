import type { RemainingTime } from '../domain/camera-state.svelte.ts';

export function formatRemaining(r: RemainingTime): string {
	if (r.kind === 'plenty') return 'plenty';
	if (r.kind === 'none') return 'full / empty';
	const m = Math.floor(r.seconds / 60);
	const h = Math.floor(m / 60);
	return h > 0 ? `${h}h ${String(m % 60).padStart(2, '0')}m` : `${m}m ${String(r.seconds % 60).padStart(2, '0')}s`;
}
