import {
	Activity,
	Bot,
	ChartNoAxesCombined,
	CircleDollarSign,
	Clock3,
	KeyRound,
	LayoutDashboard,
	Mail,
	RadioTower,
	ReceiptText,
	ScrollText,
	Settings,
	ShieldCheck,
	ShieldEllipsis,
	Users,
	WalletCards,
	Webhook,
} from "lucide-react";
import {
	hasSystemPermission,
	type SystemPermission,
	type SystemPermissionGrant,
	systemPermission,
} from "#/features/access/system-rbac";
import { m } from "#/paraglide/messages";
import type { SidebarData } from "../types";

export type NavigationModuleId =
	| "dashboard"
	| "orders"
	| "payments"
	| "reviews"
	| "receiving-methods"
	| "api-keys"
	| "webhooks"
	| "telegram"
	| "email"
	| "payment-settings"
	| "access"
	| "operations"
	| "settings";

type NavigationEntry = {
	id: string;
	title: () => string;
	url: string;
	icon: typeof LayoutDashboard;
	permission: SystemPermission;
	activePrefixes?: readonly string[];
};

type NavigationModule = {
	id: NavigationModuleId;
	title: () => string;
	icon: typeof LayoutDashboard;
	entries: readonly NavigationEntry[];
};

type NavigationGroup = {
	id: string;
	title: () => string;
	modules: readonly NavigationModule[];
};

const entry = (
	id: string,
	title: () => string,
	url: string,
	icon: typeof LayoutDashboard,
	permission: SystemPermission,
	activePrefixes?: readonly string[],
): NavigationEntry => ({ id, title, url, icon, permission, activePrefixes });

export const navigationGroups: readonly NavigationGroup[] = [
	{
		id: "workbench",
		title: () => m.nav_group_workbench(),
		modules: [
			{
				id: "dashboard",
				title: () => m.payment_dashboard_title(),
				icon: LayoutDashboard,
				entries: [
					entry(
						"dashboard",
						() => m.payment_dashboard_title(),
						"/admin",
						LayoutDashboard,
						systemPermission("dashboard", "read"),
					),
				],
			},
		],
	},
	{
		id: "payments",
		title: () => m.nav_group_payment_operations(),
		modules: [
			{
				id: "orders",
				title: () => m.system_nav_orders(),
				icon: WalletCards,
				entries: [
					entry(
						"orders",
						() => m.system_nav_orders(),
						"/admin/orders",
						WalletCards,
						systemPermission("orders", "read"),
					),
				],
			},
			{
				id: "payments",
				title: () => m.system_nav_payments(),
				icon: CircleDollarSign,
				entries: [
					entry(
						"payments",
						() => m.system_nav_payments(),
						"/admin/payments",
						CircleDollarSign,
						systemPermission("payments", "read"),
					),
				],
			},
			{
				id: "reviews",
				title: () => m.payment_reviews_title(),
				icon: ReceiptText,
				entries: [
					entry(
						"reviews",
						() => m.payment_reviews_title(),
						"/admin/payment-reviews",
						ReceiptText,
						systemPermission("payment_reviews", "read"),
					),
				],
			},
			{
				id: "receiving-methods",
				title: () => m.receiving_methods_title(),
				icon: RadioTower,
				entries: [
					entry(
						"receiving-methods",
						() => m.receiving_methods_title(),
						"/admin/receiving-methods",
						RadioTower,
						systemPermission("receiving_methods", "read"),
					),
				],
			},
		],
	},
	{
		id: "integrations",
		title: () => m.nav_group_open_integrations(),
		modules: [
			{
				id: "api-keys",
				title: () => m.api_keys_title(),
				icon: KeyRound,
				entries: [
					entry(
						"api-keys",
						() => m.api_keys_title(),
						"/admin/api-keys",
						KeyRound,
						systemPermission("api_keys", "read"),
					),
				],
			},
			{
				id: "webhooks",
				title: () => m.system_nav_webhooks(),
				icon: Webhook,
				entries: [
					entry(
						"webhooks-inbound",
						() => m.webhooks_inbound_title(),
						"/admin/webhooks",
						Webhook,
						systemPermission("webhooks", "read"),
					),
					entry(
						"webhooks-inbound-records",
						() => m.webhooks_inbound_records_title(),
						"/admin/webhooks/inbound-records",
						Activity,
						systemPermission("webhooks", "read"),
						["/admin/webhooks/provider-events"],
					),
					entry(
						"webhooks-records",
						() => m.webhooks_outbound_records_title(),
						"/admin/webhooks/records",
						Activity,
						systemPermission("webhooks", "read"),
					),
				],
			},
			{
				id: "telegram",
				title: () => m.system_nav_telegram(),
				icon: Bot,
				entries: [
					entry(
						"telegram-bot",
						() => m.telegram_bot(),
						"/admin/telegram",
						Bot,
						systemPermission("telegram", "read"),
					),
					entry(
						"telegram-notifications",
						() => m.nav_telegram_subscriptions(),
						"/admin/telegram/notifications",
						Activity,
						systemPermission("telegram", "read"),
					),
					entry(
						"telegram-commands",
						() => m.nav_telegram_commands(),
						"/admin/telegram/commands",
						Bot,
						systemPermission("telegram", "read"),
					),
				],
			},
		],
	},
	{
		id: "system",
		title: () => m.nav_group_system_management(),
		modules: [
			{
				id: "email",
				title: () => m.settings_group_email(),
				icon: Mail,
				entries: [
					entry(
						"email",
						() => m.settings_group_email(),
						"/admin/email",
						Mail,
						systemPermission("settings", "read"),
					),
				],
			},
			{
				id: "payment-settings",
				title: () => m.nav_payment_settings(),
				icon: CircleDollarSign,
				entries: [
					entry(
						"payment-methods",
						() => m.nav_payment_capabilities(),
						"/admin/payment-settings",
						WalletCards,
						systemPermission("payment_settings", "read"),
					),
					entry(
						"payment-ingresses",
						() => m.nav_connection_config(),
						"/admin/payment-settings/ingresses",
						Activity,
						systemPermission("payment_settings", "read"),
					),
					entry(
						"crypto-rates",
						() => m.nav_crypto_rates(),
						"/admin/payment-settings/rates",
						ChartNoAxesCombined,
						systemPermission("payment_settings", "read"),
					),
					entry(
						"fiat-rates",
						() => m.nav_fiat_rates(),
						"/admin/payment-settings/rates/fiat",
						CircleDollarSign,
						systemPermission("payment_settings", "read"),
					),
				],
			},
			{
				id: "access",
				title: () => m.nav_user_access(),
				icon: ShieldCheck,
				entries: [
					entry(
						"users",
						() => m.nav_user_management(),
						"/admin/access/users",
						Users,
						systemPermission("users", "read"),
					),
					entry(
						"roles",
						() => m.nav_role_management(),
						"/admin/access/roles",
						ShieldCheck,
						systemPermission("roles", "read"),
					),
					entry(
						"permission-modules",
						() => m.access_permission_modules(),
						"/admin/access/modules",
						ShieldCheck,
						systemPermission("roles", "read"),
					),
					entry(
						"permission-bits",
						() => m.access_permission_bits(),
						"/admin/access/permission-bits",
						ShieldEllipsis,
						systemPermission("roles", "read"),
					),
				],
			},
			{
				id: "operations",
				title: () => m.nav_operations_center(),
				icon: Activity,
				entries: [
					entry(
						"queues",
						() => m.nav_queue_monitoring(),
						"/admin/operations/queues",
						Activity,
						systemPermission("operations", "read"),
					),
					entry(
						"scheduled",
						() => m.nav_scheduled_tasks(),
						"/admin/operations/scheduled",
						Clock3,
						systemPermission("operations", "read"),
					),
					entry(
						"audit",
						() => m.nav_audit_logs(),
						"/admin/operations/audit-logs",
						ScrollText,
						systemPermission("audit", "read"),
					),
				],
			},
			{
				id: "settings",
				title: () => m.system_nav_settings(),
				icon: Settings,
				entries: [
					entry(
						"settings-branding",
						() => m.settings_group_brand(),
						"/admin/settings",
						Settings,
						systemPermission("settings", "read"),
					),
					entry(
						"settings-orders",
						() => m.settings_group_orders(),
						"/admin/settings/orders",
						ReceiptText,
						systemPermission("settings", "read"),
					),
					entry(
						"settings-payment",
						() => m.settings_group_payment(),
						"/admin/settings/payment",
						CircleDollarSign,
						systemPermission("settings", "read"),
					),
					entry(
						"settings-access",
						() => m.settings_group_access(),
						"/admin/settings/access",
						ShieldCheck,
						systemPermission("settings", "read"),
					),
					entry(
						"settings-webhook",
						() => m.settings_group_webhook(),
						"/admin/settings/webhooks",
						Webhook,
						systemPermission("settings", "read"),
					),
					entry(
						"settings-auth",
						() => m.settings_group_auth(),
						"/admin/settings/auth",
						KeyRound,
						systemPermission("settings", "read"),
					),
					entry(
						"settings-secrets",
						() => m.settings_group_secrets(),
						"/admin/settings/secrets",
						ShieldCheck,
						systemPermission("settings", "read"),
					),
					entry(
						"settings-scanning",
						() => m.settings_group_scanning(),
						"/admin/settings/scanning",
						Activity,
						systemPermission("settings", "read"),
					),
					entry(
						"settings-retention",
						() => m.settings_group_retention(),
						"/admin/settings/retention",
						Clock3,
						systemPermission("settings", "read"),
					),
				],
			},
		],
	},
] as const;

export function visibleModuleEntries(
	moduleId: NavigationModuleId,
	permissions: readonly SystemPermissionGrant[],
) {
	const module = navigationGroups
		.flatMap((group) => group.modules)
		.find((candidate) => candidate.id === moduleId);
	return (
		module?.entries.filter((item) =>
			hasSystemPermission(permissions, item.permission),
		) ?? []
	);
}

export function firstAllowedAdminUrl(
	permissions: readonly SystemPermissionGrant[],
) {
	return navigationGroups
		.flatMap((group) => group.modules)
		.flatMap((module) => module.entries)
		.find((item) => hasSystemPermission(permissions, item.permission))?.url;
}

export function systemSidebarData(
	permissions: readonly SystemPermissionGrant[],
): SidebarData {
	const navGroups: SidebarData["navGroups"] = [];
	for (const group of navigationGroups) {
		const items: SidebarData["navGroups"][number]["items"] = [];
		for (const module of group.modules) {
			const visible = module.entries.filter((candidate) =>
				hasSystemPermission(permissions, candidate.permission),
			);
			if (!visible.length) continue;
			if (visible.length === 1) {
				const [first] = visible;
				if (!first) continue;
				items.push({
					id: module.id,
					title: module.title(),
					url: first.url,
					icon: module.icon,
					activeUrls:
						module.entries.length > 1
							? module.entries.map((candidate) => candidate.url)
							: undefined,
					activePrefixes: first.activePrefixes
						? [...first.activePrefixes]
						: undefined,
				});
			} else {
				items.push({
					id: module.id,
					title: module.title(),
					icon: module.icon,
					items: visible.map((item) => ({
						id: item.id,
						title: item.title(),
						url: item.url,
						icon: item.icon,
						activePrefixes: item.activePrefixes
							? [...item.activePrefixes]
							: undefined,
					})),
				});
			}
		}
		if (items.length)
			navGroups.push({ id: group.id, title: group.title(), items });
	}
	return {
		navGroups,
	};
}

export function permissionForAdminPath(
	pathname: string,
): SystemPermission | undefined {
	const normalized =
		pathname.length > 1 ? pathname.replace(/\/+$/, "") : pathname;
	const entries = navigationGroups
		.flatMap((group) => group.modules)
		.flatMap((module) => module.entries);
	const exact = entries.find((candidate) => candidate.url === normalized);
	if (exact) return exact.permission;
	if (/^\/admin\/webhooks\/[^/]+$/.test(normalized))
		return systemPermission("webhooks", "read");
	return undefined;
}

export function canAccessAdminPath(
	pathname: string,
	permissions: readonly SystemPermissionGrant[],
) {
	const normalized =
		pathname.length > 1 ? pathname.replace(/\/+$/, "") : pathname;
	const permission = permissionForAdminPath(normalized);
	if (permission) return hasSystemPermission(permissions, permission);
	const module = navigationGroups
		.flatMap((group) => group.modules)
		.find((candidate) =>
			candidate.entries.every((item) => item.url.startsWith(`${normalized}/`)),
		);
	if (module)
		return module.entries.some((item) =>
			hasSystemPermission(permissions, item.permission),
		);
	return false;
}
