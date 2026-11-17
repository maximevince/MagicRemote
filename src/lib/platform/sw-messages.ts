// Messages between the page and the service worker. Shared by both sides, so no DOM or worker types.

export const SW_MESSAGE = {
	/** Page → waiting worker: the user asked to update now. */
	skipWaiting: 'magicremote:skip-waiting',
	/** Worker → page: the update was not applied. */
	refused: 'magicremote:update-refused'
} as const;

export type SwRequest = { type: typeof SW_MESSAGE.skipWaiting };

export type SwRefusal = 'other-windows';

export type SwReply = { type: typeof SW_MESSAGE.refused; reason: SwRefusal };

export function isSwReply(data: unknown): data is SwReply {
	return typeof data === 'object' && data !== null && (data as { type?: unknown }).type === SW_MESSAGE.refused;
}
