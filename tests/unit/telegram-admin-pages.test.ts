import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = resolve(import.meta.dirname, "../..");

const resources = [
	{
		id: "bots",
		page: "bots",
		route: "index",
		component: "TelegramBotsPage",
		listFunction: "listTelegramBotsFn",
		server: "bots-admin",
	},
	{
		id: "notifications",
		page: "notifications",
		route: "notifications",
		component: "TelegramNotificationsPage",
		listFunction: "listTelegramNotificationsFn",
		server: "notifications-admin",
	},
	{
		id: "commands",
		page: "commands",
		route: "commands",
		component: "TelegramCommandsPage",
		listFunction: "listTelegramCommandsFn",
		server: "commands-admin",
	},
] as const;

describe("Telegram admin page ownership", () => {
	it.each(resources)("mounts the $id route directly to its semantic page", ({
		route,
		page,
		component,
	}) => {
		const routeSource = read(`src/routes/admin/telegram/${route}.tsx`);
		expect(routeSource).toContain(`#/features/telegram/pages/${page}`);
		expect(routeSource).toContain(`component: ${component}`);
		expect(routeSource).not.toMatch(/section=|kind=/);
	});

	it.each(
		resources,
	)("keeps the $id table, query and mutation owner in one page", ({
		id,
		page,
		listFunction,
	}) => {
		const source = read(`src/features/telegram/pages/${page}.tsx`);
		expect(source).toContain("<ProTable");
		expect(source).toContain("client.fetchQuery");
		expect(source).toContain(listFunction);
		expect(source).toContain(`"admin", "telegram", "${id}"`);
		expect(source).toContain("beforeCreatedAt");
		expect(source).toContain("onSuccess: refresh");
		for (const other of resources) {
			if (other.id !== id) expect(source).not.toContain(other.listFunction);
		}
		expect(source).not.toMatch(/TelegramPage|section ===|kind ===/);
	});

	it.each(
		resources,
	)("keeps $id authorization and stable D1 pagination in its resource module", ({
		server,
		listFunction,
	}) => {
		const source = read(`src/features/telegram/server/${server}.ts`);
		expect(source).toContain(`export const ${listFunction}`);
		expect(source).toContain('systemPermission("telegram", "read")');
		expect(source).toContain("beforeCreatedAt");
		expect(source).toContain("db.batch([");
		expect(source).toMatch(/LIMIT \? OFFSET \?/);
	});

	it("removes the section dispatcher and aggregate Server Function owner", () => {
		expect(
			existsSync(resolve(root, "src/features/telegram/pages/admin.tsx")),
		).toBe(false);
		expect(
			existsSync(resolve(root, "src/features/telegram/server/admin.ts")),
		).toBe(false);
	});

	it("exposes the audited reconcile action from the commands page", () => {
		const page = read("src/features/telegram/pages/commands.tsx");
		expect(page).toContain("reconcileTelegramDefaultsFn");
		expect(page).toContain("m.telegram_reconcile_defaults()");
		const server = read("src/features/telegram/server/commands-admin.ts");
		expect(server).toMatch(
			/export const reconcileTelegramDefaultsFn[\s\S]*systemPermission\("telegram", "update"\)[\s\S]*reconcileTelegramDefaults\(context\.db, now\)[\s\S]*"telegram\.defaults_reconciled"/,
		);
	});

	it("lays out notification forms without nested event cards", () => {
		const source = read("src/features/telegram/pages/notifications.tsx");
		expect(source).toContain(
			'fieldsClassName="grid gap-4 space-y-0 sm:grid-cols-2"',
		);
		expect(source).toContain('modalClassName="sm:max-w-3xl"');
		expect(source).toContain(
			'templateContentFormField("templateTranslations", false)',
		);
		expect(source).toContain("flatItems");
	});
});

function read(file: string) {
	return readFileSync(resolve(root, file), "utf8");
}
