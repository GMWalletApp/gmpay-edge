import type { SupportedLocale } from "#/lib/locales";

export type SiteBrand = {
	name: string;
	logoUrl: string;
	title: string;
	supportUrl: string;
	backgroundColor: string;
	backgroundImageUrl: string;
	defaultLocale: SupportedLocale;
};

export const defaultSiteBrand: SiteBrand = {
	name: "GMPay Edge",
	logoUrl: "/favicon.png",
	title: "GMPay Edge",
	supportUrl: "",
	backgroundColor: "",
	backgroundImageUrl: "",
	defaultLocale: "en-US",
};
