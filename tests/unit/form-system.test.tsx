// @vitest-environment jsdom

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Password } from "#/components/pro/base/fields/input";
import { formBooleanValue } from "#/components/pro/form";
import { AuthAnimationProvider } from "#/features/auth/components/auth-animation-context";
import { UserAuthForm } from "#/features/auth/components/user-auth-form";
import { m } from "#/paraglide/messages";

(
	globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock("@tanstack/react-router", () => ({
	Link: ({ children }: { children: React.ReactNode }) => (
		<a href="/">{children}</a>
	),
	useNavigate: () => vi.fn(),
}));
vi.mock("#/features/auth/auth-client", () => ({
	authClient: { signIn: { email: vi.fn() } },
}));

describe("application form system", () => {
	let container: HTMLDivElement | undefined;

	afterEach(() => {
		container?.remove();
		container = undefined;
	});

	it("keeps TanStack Form as the only application form runtime", () => {
		const packageJson = JSON.parse(
			readFileSync(resolve("package.json"), "utf8"),
		) as { dependencies?: Record<string, string> };
		expect(packageJson.dependencies).toHaveProperty("@tanstack/react-form");
		expect(packageJson.dependencies).not.toHaveProperty("react-hook-form");
		expect(packageJson.dependencies).not.toHaveProperty("@hookform/resolvers");

		for (const path of [
			"src/features/auth/components/user-auth-form.tsx",
			"src/features/installation/pages/install.tsx",
		]) {
			const source = readFileSync(resolve(path), "utf8");
			expect(source, path).toContain('from "@tanstack/react-form"');
			expect(source, path).not.toMatch(/react-hook-form|@hookform\/resolvers/);
		}
	});

	it("distributes localized schema errors to named sign-in fields", async () => {
		container = document.createElement("div");
		document.body.appendChild(container);
		const root = createRoot(container);

		await act(async () => {
			root.render(
				<AuthAnimationProvider>
					<UserAuthForm />
				</AuthAnimationProvider>,
			);
		});
		await act(async () => {
			container?.querySelector("form")?.requestSubmit();
			await Promise.resolve();
		});

		const email = container.querySelector<HTMLInputElement>("#sign-in-email");
		const password =
			container.querySelector<HTMLInputElement>("#sign-in-password");
		expect(email?.getAttribute("aria-invalid")).toBe("true");
		expect(password?.getAttribute("aria-invalid")).toBe("true");
		expect(container.textContent).toContain(m.auth_email_required());
		expect(container.textContent).toContain(m.auth_password_required());

		await act(async () => root.unmount());
	});

	it("keeps the password visibility control keyboard reachable", async () => {
		container = document.createElement("div");
		document.body.appendChild(container);
		const root = createRoot(container);

		await act(async () => {
			root.render(<Password aria-label={m.common_password()} />);
		});

		const button = container.querySelector<HTMLButtonElement>("button");
		expect(button?.tabIndex).toBe(0);
		expect(button?.getAttribute("aria-label")).toBe(m.pro_field_showPassword());

		await act(async () => root.unmount());
	});

	it("parses serialized switch values without treating false as truthy", () => {
		expect(formBooleanValue(false)).toBe(false);
		expect(formBooleanValue("false")).toBe(false);
		expect(formBooleanValue(undefined)).toBe(false);
		expect(formBooleanValue(true)).toBe(true);
		expect(formBooleanValue("true")).toBe(true);
	});
});
