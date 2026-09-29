// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const auth = vi.hoisted(() => ({
	enable: vi.fn(),
	verifyTotp: vi.fn(),
	disable: vi.fn(),
	refetch: vi.fn(),
}));
const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));

vi.mock("#/features/auth/auth-client", () => ({
	authClient: {
		useSession: () => ({
			data: { user: { twoFactorEnabled: false } },
			refetch: auth.refetch,
		}),
		twoFactor: {
			enable: auth.enable,
			verifyTotp: auth.verifyTotp,
			disable: auth.disable,
		},
	},
}));
vi.mock("sonner", () => ({ toast }));

import { TwoFactorDialog } from "#/layouts/components/two-factor-dialog";
import { m } from "#/paraglide/messages";

(
	globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const backupCodes = ["alpha-code-1", "bravo-code-2", "charlie-code-3"];
const expectedExport = `${backupCodes.join("\n")}\n`;

describe("two-factor recovery code acknowledgement", () => {
	let container: HTMLDivElement | undefined;
	let root: ReturnType<typeof createRoot> | undefined;
	const onOpenChange = vi.fn();
	const clipboard = { writeText: vi.fn() };
	const downloads: string[] = [];
	const createObjectURL = vi.fn((_blob: Blob) => "blob:backup-codes");
	const revokeObjectURL = vi.fn();

	beforeEach(() => {
		Object.defineProperty(navigator, "clipboard", {
			value: clipboard,
			configurable: true,
		});
		Object.assign(URL, { createObjectURL, revokeObjectURL });
		vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (
			this: HTMLAnchorElement,
		) {
			downloads.push(this.download);
		});
		clipboard.writeText.mockResolvedValue(undefined);
		auth.enable.mockResolvedValue({
			data: {
				method: "totp",
				totpURI:
					"otpauth://totp/GMPay%20Edge:root%40example.com?secret=JBSWY3DPEHPK3PXP&issuer=GMPay%20Edge",
				backupCodes,
			},
			error: null,
		});
		auth.verifyTotp.mockResolvedValue({ data: { status: true }, error: null });
		auth.refetch.mockResolvedValue(undefined);
	});

	afterEach(async () => {
		if (root) await act(async () => root?.unmount());
		container?.remove();
		container = undefined;
		root = undefined;
		downloads.length = 0;
		vi.restoreAllMocks();
		for (const mock of [
			auth.enable,
			auth.verifyTotp,
			auth.refetch,
			clipboard.writeText,
			createObjectURL,
			revokeObjectURL,
			onOpenChange,
			toast.success,
			toast.error,
		])
			mock.mockReset();
	});

	async function renderDialog() {
		container = document.createElement("div");
		document.body.appendChild(container);
		root = createRoot(container);
		await act(async () => {
			root?.render(<TwoFactorDialog open onOpenChange={onOpenChange} />);
		});
	}

	function button(label: string) {
		return [...document.body.querySelectorAll("button")].find(
			(candidate) =>
				candidate.textContent?.trim() === label ||
				candidate.getAttribute("aria-label") === label,
		);
	}

	async function type(id: string, value: string) {
		const input = document.body.querySelector<HTMLInputElement>(`#${id}`);
		if (!input) throw new Error(`Missing input #${id}`);
		await act(async () => {
			input.focus();
			input.setRangeText(value);
			input.dispatchEvent(new Event("input", { bubbles: true }));
		});
	}

	async function click(element: Element | null | undefined) {
		if (!(element instanceof HTMLElement))
			throw new Error("Missing clickable element");
		await act(async () => {
			element.click();
		});
	}

	it("requires acknowledging saved recovery codes and offers copy and download", async () => {
		await renderDialog();
		await type("two-factor-password", "an-adequately-long-password");
		await click(button(m.account_two_factor_enable()));
		expect(auth.enable).toHaveBeenCalledWith({
			password: "an-adequately-long-password",
			issuer: "GMPay Edge",
		});

		expect(document.body.querySelector('svg[width="176"]')).not.toBeNull();
		for (const code of backupCodes)
			expect(document.body.textContent).toContain(code);
		expect(button(m.auth_two_factor_verify())?.disabled).toBe(true);

		await type("totp-code", "123456");
		expect(button(m.auth_two_factor_verify())?.disabled).toBe(true);

		await click(button(m.common_copy()));
		expect(clipboard.writeText).toHaveBeenCalledWith(expectedExport);

		await click(button(m.account_two_factor_download_codes()));
		expect(createObjectURL).toHaveBeenCalledTimes(1);
		const blob = createObjectURL.mock.calls[0]?.[0];
		expect(await blob?.text()).toBe(expectedExport);
		expect(downloads).toEqual(["gmpay-edge-two-factor-backup-codes.txt"]);
		expect(revokeObjectURL).toHaveBeenCalledWith("blob:backup-codes");

		await click(document.body.querySelector("#two-factor-backup-codes-saved"));
		expect(button(m.auth_two_factor_verify())?.disabled).toBe(false);

		await click(button(m.auth_two_factor_verify()));
		expect(auth.verifyTotp).toHaveBeenCalledWith({ code: "123456" });
		expect(auth.refetch).toHaveBeenCalledTimes(1);
		expect(toast.success).toHaveBeenCalledWith(m.account_two_factor_enabled());
		expect(onOpenChange).toHaveBeenCalledWith(false);
	});

	it("keeps the confirm action locked until both the code and the acknowledgement are present", async () => {
		await renderDialog();
		await type("two-factor-password", "an-adequately-long-password");
		await click(button(m.account_two_factor_enable()));
		await click(document.body.querySelector("#two-factor-backup-codes-saved"));
		expect(button(m.auth_two_factor_verify())?.disabled).toBe(true);
		await type("totp-code", "12345");
		expect(button(m.auth_two_factor_verify())?.disabled).toBe(true);
		await type("totp-code", "6");
		expect(button(m.auth_two_factor_verify())?.disabled).toBe(false);
		expect(auth.verifyTotp).not.toHaveBeenCalled();
	});
});
