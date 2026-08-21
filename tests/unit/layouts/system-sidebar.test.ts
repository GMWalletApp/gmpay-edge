import { readdir, readFile } from "node:fs/promises";
import { relative, resolve, sep } from "node:path";
import { describe, expect, it } from "vitest";
import { systemPermission } from "#/features/access/system-rbac";
import { commandMenuGroups } from "#/layouts/components/command-menu";
import {
	canAccessAdminPath,
	firstAllowedAdminUrl,
	navigationGroups,
	permissionForAdminPath,
	systemSidebarData,
	visibleModuleEntries,
} from "#/layouts/components/data/sidebar-data";
import { matchesNavLocation } from "#/layouts/components/nav-group";

const urls = (permissions: Parameters<typeof systemSidebarData>[0]) =>
	systemSidebarData(permissions).navGroups.flatMap((group) =>
		group.items.flatMap((item) =>
			item.items
				? item.items.map((child) => String(child.url))
				: [String(item.url)],
		),
	);

describe("admin navigation", () => {
	it("keeps the complete four-group structure and stable order", () => {
		const all = navigationGroups
			.flatMap((group) => group.modules)
			.flatMap((module) => module.entries.map((item) => item.permission));
		const navigation = systemSidebarData(all);
		expect(navigation.navGroups.map((group) => group.id)).toEqual([
			"workbench",
			"payments",
			"integrations",
			"system",
		]);
		expect(
			navigation.navGroups.map((group) => group.items.map((item) => item.id)),
		).toEqual([
			["dashboard"],
			["orders", "payments", "reviews", "receiving-methods"],
			["api-keys", "webhooks", "telegram"],
			["email", "payment-settings", "access", "operations", "settings"],
		]);
	});

	it.each([
		[systemPermission("users", "read"), ["/admin/access/users"]],
		[
			systemPermission("roles", "read"),
			[
				"/admin/access/roles",
				"/admin/access/modules",
				"/admin/access/permission-bits",
			],
		],
		[systemPermission("audit", "read"), ["/admin/operations/audit-logs"]],
	] as const)("projects only permitted destinations into the command menu for %j", (permission, expected) => {
		const urls = commandMenuGroups(systemSidebarData([permission])).flatMap(
			(group) => group.items.map((item) => String(item.url)),
		);
		expect(urls).toEqual(expected);
	});

	it.each([
		[
			[systemPermission("users", "read")],
			"/admin/access/users",
			["/admin/access/users"],
		],
		[
			[systemPermission("roles", "read")],
			"/admin/access/roles",
			[
				"/admin/access/roles",
				"/admin/access/modules",
				"/admin/access/permission-bits",
			],
		],
		[
			[systemPermission("users", "read"), systemPermission("roles", "read")],
			"/admin/access/users",
			[
				"/admin/access/users",
				"/admin/access/roles",
				"/admin/access/modules",
				"/admin/access/permission-bits",
			],
		],
	] as const)("chooses the first allowed user-access page for %j", (permissions, expected, visible) => {
		expect(visibleModuleEntries("access", permissions)[0]?.url).toBe(expected);
		expect(urls(permissions)).toEqual(visible);
	});

	it("filters operations children independently and removes empty groups", () => {
		expect(
			visibleModuleEntries("operations", [
				systemPermission("operations", "read"),
			]).map((item) => item.id),
		).toEqual(["queues", "scheduled"]);
		expect(
			visibleModuleEntries("operations", [
				systemPermission("audit", "read"),
			]).map((item) => item.id),
		).toEqual(["audit"]);
		expect(systemSidebarData([]).navGroups).toEqual([]);
	});

	it("expands modules with multiple visible children in the main sidebar", () => {
		const navigation = systemSidebarData([
			systemPermission("payment_settings", "read"),
		]);
		expect(
			navigation.navGroups
				.flatMap((group) => group.items)
				.filter((item) => item.items).length,
		).toBeGreaterThan(0);
	});

	it("unifies payment settings while isolating review permissions", () => {
		expect(urls([systemPermission("payment_settings", "read")])).toEqual([
			"/admin/payment-settings",
			"/admin/payment-settings/ingresses",
			"/admin/payment-settings/rates",
			"/admin/payment-settings/rates/fiat",
		]);
		expect(urls([systemPermission("payment_reviews", "read")])).toEqual([
			"/admin/payment-reviews",
		]);
		expect(urls([systemPermission("telegram", "read")])).toEqual([
			"/admin/telegram",
			"/admin/telegram/notifications",
			"/admin/telegram/commands",
		]);
	});

	it("keeps notification setup and both record directions distinct", () => {
		const webhookEntries = visibleModuleEntries("webhooks", [
			systemPermission("webhooks", "read"),
		]);
		expect(webhookEntries.map((item) => item.id)).toEqual([
			"webhooks-inbound",
			"webhooks-inbound-records",
			"webhooks-records",
		]);
		expect(webhookEntries.map((item) => item.url)).toEqual([
			"/admin/webhooks",
			"/admin/webhooks/inbound-records",
			"/admin/webhooks/records",
		]);
		expect(webhookEntries[1]?.activePrefixes).toEqual([
			"/admin/webhooks/provider-events",
		]);
	});

	it("uses explicit fail-closed route permissions", () => {
		expect(permissionForAdminPath("/admin/not-a-route")).toBeUndefined();
		expect(
			canAccessAdminPath("/admin/not-a-route", [
				systemPermission("dashboard", "read"),
			]),
		).toBe(false);
		expect(
			canAccessAdminPath("/admin/access/users", [
				systemPermission("users", "read"),
			]),
		).toBe(true);
		expect(
			canAccessAdminPath("/admin/access/roles", [
				systemPermission("users", "read"),
			]),
		).toBe(false);
		expect(
			canAccessAdminPath("/admin/webhooks/example", [
				systemPermission("webhooks", "read"),
			]),
		).toBe(true);
	});

	it("keeps navigation identifiers, URLs, and permissions authoritative", () => {
		const modules = navigationGroups.flatMap((group) => group.modules);
		const entries = modules.flatMap((module) => module.entries);
		expect(new Set(modules.map((module) => module.id)).size).toBe(
			modules.length,
		);
		expect(new Set(entries.map((entry) => entry.id)).size).toBe(entries.length);
		expect(new Set(entries.map((entry) => entry.url)).size).toBe(
			entries.length,
		);
		for (const entry of entries) {
			expect(permissionForAdminPath(entry.url), entry.url).toEqual(
				entry.permission,
			);
			expect(canAccessAdminPath(entry.url, [entry.permission]), entry.url).toBe(
				true,
			);
		}
	});

	it("keeps page titles aligned with their authoritative navigation labels", async () => {
		const contracts = [
			["dashboard/pages/admin.tsx", "m.payment_dashboard_title()"],
			["api-keys/pages/admin.tsx", "m.api_keys_title()"],
			["users/pages/admin-list.tsx", "m.nav_user_management()"],
			["access/pages/admin.tsx", "m.nav_role_management()"],
			["payment-settings/pages/admin-rates.tsx", "m.nav_crypto_rates()"],
			["payment-settings/pages/admin-rates.tsx", "m.nav_fiat_rates()"],
			["operations/pages/jobs.tsx", "m.nav_scheduled_tasks()"],
			["operations/pages/audit-logs.tsx", "m.nav_audit_logs()"],
			["telegram/pages/bots.tsx", "m.telegram_bot()"],
			["telegram/pages/notifications.tsx", "m.nav_telegram_subscriptions()"],
			["telegram/pages/commands.tsx", "m.nav_telegram_commands()"],
			[
				"webhooks/pages/admin-provider-events.tsx",
				"m.webhooks_provider_events_title()",
			],
		] as const;
		for (const [path, title] of contracts) {
			const source = await readFile(
				new URL(`../../../src/features/${path}`, import.meta.url),
				"utf8",
			);
			expect(source, path).toContain(title);
		}
	});

	it("keeps API credential identity and enabled state in separate columns", async () => {
		const source = await readFile(
			new URL(
				"../../../src/features/api-keys/pages/admin.tsx",
				import.meta.url,
			),
			"utf8",
		);
		expect(source).toContain(
			'accessorKey: "enabled",\n\t\t\t\theader: m.common_enabled()',
		);
		expect(source).toContain(
			'accessorKey: "name",\n\t\t\t\theader: m.common_name()',
		);
		expect(source).toContain(
			'accessorKey: "pid",\n\t\t\t\theader: m.api_keys_key()',
		);
	});

	it("classifies every admin page route and no unknown route", async () => {
		const permissions = navigationGroups
			.flatMap((group) => group.modules)
			.flatMap((module) => module.entries.map((item) => item.permission));
		const root = resolve(
			new URL("../../../src/routes/admin", import.meta.url).pathname,
		);
		const pages = (await adminRouteFiles(root)).map((file) => {
			const relativePath = relative(root, file).split(sep).join("/");
			const path = relativePath
				.replace(/\.tsx$/, "")
				.replace(/(^|\/)index$/, "")
				.replaceAll("$endpointId", "inbound-test");
			return `/admin${path ? `/${path}` : ""}`;
		});
		for (const path of pages)
			expect(canAccessAdminPath(path, permissions)).toBe(true);
		expect(canAccessAdminPath("/admin/unknown", permissions)).toBe(false);
	});

	it("uses the same filtered entries for the first global destination", () => {
		expect(firstAllowedAdminUrl([systemPermission("audit", "read")])).toBe(
			"/admin/operations/audit-logs",
		);
		expect(firstAllowedAdminUrl([])).toBeUndefined();
	});

	it("selects only the exact child while a parent can cover all module routes", () => {
		expect(
			matchesNavLocation(
				{ title: "Dashboard", url: "/admin" },
				{ pathname: "/admin/orders" },
			),
		).toBe(false);
		expect(
			matchesNavLocation(
				{ title: "Webhook", url: "/admin/webhooks" },
				{ pathname: "/admin/webhooks/records" },
			),
		).toBe(false);
		expect(
			matchesNavLocation(
				{
					title: "Webhook",
					url: "/admin/webhooks",
					activeUrls: ["/admin/webhooks", "/admin/webhooks/records"],
				},
				{ pathname: "/admin/webhooks/records" },
			),
		).toBe(true);
		expect(
			matchesNavLocation(
				{
					title: "Inbound Webhook",
					url: "/admin/webhooks",
				},
				{ pathname: "/admin/webhooks/records" },
			),
		).toBe(false);
	});
});

async function adminRouteFiles(directory: string): Promise<string[]> {
	const entries = await readdir(directory, { withFileTypes: true });
	const nested = await Promise.all(
		entries.map((entry) => {
			const path = resolve(directory, entry.name);
			if (entry.isDirectory()) return adminRouteFiles(path);
			return Promise.resolve(
				entry.name.endsWith(".tsx") && entry.name !== "route.tsx" ? [path] : [],
			);
		}),
	);
	return nested.flat();
}
