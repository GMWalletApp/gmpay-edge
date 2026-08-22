import { useSelector } from "@tanstack/react-store";
import { Store } from "@tanstack/store";

export type AuthUser = {
	id: string;
	name: string;
	email: string;
	image?: string | null;
	enabled?: boolean | null;
};

type AuthState = {
	user: AuthUser | null;
};

type AuthActions = {
	setUser: (user: AuthUser | null) => void;
	clearUser: () => void;
};

export const authStore = new Store<AuthState, AuthActions>(
	{ user: null } satisfies AuthState,
	(store) => ({
		setUser: (user: AuthUser | null) =>
			store.setState((state) => ({ ...state, user })),
		clearUser: () => store.setState((state) => ({ ...state, user: null })),
	}),
);

export function useAuthUser() {
	return useSelector(authStore, (state) => state.user);
}
