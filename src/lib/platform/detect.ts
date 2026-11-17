export type Os = 'windows' | 'macos' | 'linux' | 'chromeos' | 'android' | 'ios' | 'other';

interface UaData {
	platform?: string;
}

export function detectOs(nav: Navigator | undefined = globalThis.navigator): Os {
	if (!nav) return 'other';
	const platform = ((nav as Navigator & { userAgentData?: UaData }).userAgentData?.platform ?? '').toLowerCase();
	const ua = nav.userAgent.toLowerCase();
	const s = `${platform} ${ua}`;
	if (s.includes('android')) return 'android';
	if (s.includes('cros') || s.includes('chrome os')) return 'chromeos';
	if (/iphone|ipad|ios/.test(s)) return 'ios';
	if (s.includes('win')) return 'windows';
	if (s.includes('mac')) return 'macos';
	if (s.includes('linux')) return 'linux';
	return 'other';
}
