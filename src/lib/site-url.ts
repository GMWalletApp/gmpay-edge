const SITE_URL = "https://gmwallet.app";

export function absoluteSiteUrl(pathOrUrl: string) {
	if (/^https?:\/\//.test(pathOrUrl)) return pathOrUrl;

	return new URL(pathOrUrl, SITE_URL).toString();
}
