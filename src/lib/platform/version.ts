/** Build identity. Both values are injected at build time; see vite.config.ts. */
export const APP_VERSION: string = __APP_VERSION__;
export const APP_COMMIT: string = __APP_COMMIT__;

export const VERSION_LABEL = APP_COMMIT ? `v${APP_VERSION} · ${APP_COMMIT}` : `v${APP_VERSION}`;
