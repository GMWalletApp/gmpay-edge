import { Store } from "@tanstack/store";

export type Theme = "dark" | "light" | "auto";
export type ResolvedTheme = Exclude<Theme, "auto">;
export type Font = "inter" | "manrope" | "noto";
export type Direction = "ltr" | "rtl";

export const defaultTheme: Theme = "auto";
export const defaultFont: Font = "noto";
export const defaultDirection: Direction = "ltr";

const themeStorageKey = "theme";
const fontStorageKey = "font";
const directionStorageKey = "direction";

type PreferencesState = {
	theme: Theme;
	font: Font;
	direction: Direction;
	systemTheme: ResolvedTheme;
};

type PreferencesActions = {
	hydrate: () => void;
	setTheme: (theme: Theme) => void;
	resetTheme: () => void;
	setFont: (font: Font) => void;
	resetFont: () => void;
	setDirection: (direction: Direction) => void;
	resetDirection: () => void;
	setSystemTheme: (theme: ResolvedTheme) => void;
};

export const preferencesStore = new Store<PreferencesState, PreferencesActions>(
	{
		theme: defaultTheme,
		font: defaultFont,
		direction: defaultDirection,
		systemTheme: "light",
	},
	(store) => ({
		hydrate: () => store.setState(() => storedPreferences()),
		setTheme: (theme) => {
			persistLocal(themeStorageKey, theme);
			store.setState((state) => ({ ...state, theme }));
		},
		resetTheme: () => {
			removeLocal(themeStorageKey);
			store.setState((state) => ({ ...state, theme: defaultTheme }));
		},
		setFont: (font) => {
			persistLocal(fontStorageKey, font);
			store.setState((state) => ({ ...state, font }));
		},
		resetFont: () => {
			removeLocal(fontStorageKey);
			store.setState((state) => ({ ...state, font: defaultFont }));
		},
		setDirection: (direction) => {
			persistLocal(directionStorageKey, direction);
			store.setState((state) => ({ ...state, direction }));
		},
		resetDirection: () => {
			removeLocal(directionStorageKey);
			store.setState((state) => ({ ...state, direction: defaultDirection }));
		},
		setSystemTheme: (systemTheme) =>
			store.setState((state) => ({ ...state, systemTheme })),
	}),
);

function storedPreferences(): PreferencesState {
	return {
		theme: storedTheme(),
		font: storedFont(),
		direction: storedDirection(),
		systemTheme: systemTheme(),
	};
}

function storedTheme(): Theme {
	const value = readLocal(themeStorageKey);
	return value === "light" || value === "dark" || value === "auto"
		? value
		: defaultTheme;
}

function storedFont(): Font {
	const value = readLocal(fontStorageKey);
	return value === "inter" || value === "manrope" || value === "noto"
		? value
		: defaultFont;
}

function storedDirection(): Direction {
	const value = readLocal(directionStorageKey);
	return value === "ltr" || value === "rtl" ? value : defaultDirection;
}

function systemTheme(): ResolvedTheme {
	return typeof window !== "undefined" &&
		typeof window.matchMedia === "function" &&
		window.matchMedia("(prefers-color-scheme: dark)").matches
		? "dark"
		: "light";
}

function readLocal(key: string) {
	return typeof window === "undefined"
		? null
		: window.localStorage.getItem(key);
}

function persistLocal(key: string, value: string) {
	if (typeof window !== "undefined") window.localStorage.setItem(key, value);
}

function removeLocal(key: string) {
	if (typeof window !== "undefined") window.localStorage.removeItem(key);
}
