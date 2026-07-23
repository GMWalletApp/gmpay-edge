import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const root = resolve(import.meta.dirname, "../..");

const adminServerModules = [
	"src/features/access/server/admin.ts",
	"src/features/api-keys/server/admin.ts",
	"src/features/dashboard/server/admin.ts",
	"src/features/operations/server/admin.ts",
	"src/features/orders/server/admin.ts",
	"src/features/payment-reviews/server/admin.ts",
	"src/features/payment-settings/server/payment-methods.ts",
	"src/features/payment-settings/server/connection-functions.ts",
	"src/features/payment-settings/server/methods.ts",
	"src/features/payment-settings/server/rate-functions.ts",
	"src/features/payments/server/admin.ts",
	"src/features/settings/server/admin.ts",
	"src/features/telegram/server/bots-admin.ts",
	"src/features/telegram/server/notifications-admin.ts",
	"src/features/telegram/server/commands-admin.ts",
	"src/features/users/server/admin.ts",
	"src/features/webhooks/server/admin.ts",
	"src/features/webhooks/server/payment-event-sources.ts",
] as const;

const reviewedPublicServerModules = [
	"src/features/auth/server/session.ts",
	"src/features/checkout/server/functions.ts",
	"src/features/installation/server/functions.ts",
	"src/features/settings/server/site-brand-entry.ts",
	"src/features/status/server/assets.ts",
	"src/features/status/server/functions.ts",
] as const;

const reviewedInputlessPostFunctions = new Set([
	"exportAuditLogsFn",
	"removeSiteBackgroundFn",
	"removeSiteLogoFn",
	"syncTelegramCommandsFn",
]);

const adminOwnerFunctions = new Set([
	"adminActionContext",
	"adminContext",
	"adminDb",
	"adminPaymentsDb",
	"context",
	"getAdminServerContext",
	"paymentAdminContext",
	"requireAdmin",
	"sourceAdminContext",
	"sourceAdminMutationContext",
	"telegramAdminContext",
]);

const permissionContracts = [
	["dashboard:read", ["getAdminDashboardFn"]],
	["roles:read", ["listSystemAccessFn"]],
	["roles:create|update", ["saveSystemRoleFn"]],
	["roles:update", ["setSystemRoleEnabledFn"]],
	["roles:delete", ["deleteSystemRoleFn"]],
	["users:read", ["listUsersFn"]],
	["users:create|update", ["saveUserFn"]],
	["users:update", ["setUserEnabledFn", "setUserRolesFn"]],
	["users:delete", ["deleteUserFn"]],
	["api_keys:read", ["listApiKeysFn"]],
	["api_keys:create", ["createApiKeyFn"]],
	["api_keys:update", ["rotateApiKeyFn", "setApiKeyEnabledFn"]],
	["api_keys:delete", ["revokeApiKeyFn"]],
	["orders:read", ["listAdminOrdersFn"]],
	["orders:create", ["createDevelopmentOrderFn"]],
	[
		"orders:update",
		[
			"simulateDevelopmentOrderStatusFn",
			"simulateOrderPaymentFn",
			"checkAdminOrderPaymentFn",
			"cancelAdminOrderFn",
			"refundAdminOrderFn",
			"resendOrderNotificationFn",
		],
	],
	["payments:read", ["listAdminPaymentsFn"]],
	["payments:update", ["resolveLatePaymentFn"]],
	["payment_reviews:read", ["listPaymentReviewsFn"]],
	["payment_reviews:update", ["resolvePaymentReviewFn"]],
	[
		"receiving_methods:read",
		["listReceivingMethodsFn", "listReceivingMethodOptionsFn"],
	],
	["receiving_methods:create", ["createReceivingMethodFn"]],
	[
		"receiving_methods:update",
		["updateReceivingMethodFn", "setReceivingMethodEnabledFn"],
	],
	["receiving_methods:delete", ["deleteReceivingMethodFn"]],
	[
		"payment_settings:read",
		[
			"listPaymentMethodsFn",
			"getPaymentIngressesPageFn",
			"getRatesPageFn",
			"getPaymentEventSourceCallbackOriginFn",
		],
	],
	[
		"payment_settings:create",
		["createPaymentConnectionFn", "createPaymentEventSourceFn"],
	],
	[
		"payment_settings:update",
		[
			"updateProviderConnectionFn",
			"updateChainConnectionFn",
			"setPaymentConnectionEnabledFn",
			"updateManualRatesFn",
			"saveRateSyncSettingsFn",
			"updatePaymentEventSourceFn",
			"reconcilePaymentEventSourceFn",
		],
	],
	["payment_settings:test", ["testPaymentConnectionFn"]],
	[
		"webhooks:read",
		[
			"listInboundWebhookEndpointsFn",
			"listInboundWebhookReceiptsFn",
			"getInboundWebhookReceiptFn",
			"listAdminWebhooksFn",
			"getAdminWebhookDeliveryFn",
			"listPaymentProviderEventsFn",
		],
	],
	[
		"webhooks:update",
		["retryWebhookDeliveryFn", "retryPaymentProviderEventFn"],
	],
	["audit:read", ["listAuditLogsFn"]],
	["audit:create", ["exportAuditLogsFn"]],
	["operations:read", ["getOperationsOverviewFn", "getQueueOverviewFn"]],
	["operations:update", ["runOperationsTaskFn", "retryQueueFn"]],
	["settings:read", ["listSystemSettingsFn"]],
	[
		"settings:update",
		[
			"updateSystemSettingsFn",
			"uploadSiteLogoFn",
			"removeSiteLogoFn",
			"uploadSiteBackgroundFn",
			"removeSiteBackgroundFn",
		],
	],
	[
		"telegram:read",
		[
			"listTelegramBotsFn",
			"listTelegramNotificationsFn",
			"listTelegramCommandsFn",
		],
	],
	[
		"telegram:create",
		[
			"createTelegramBotFn",
			"createTelegramNotificationBindingFn",
			"createTelegramCommandFn",
		],
	],
	[
		"telegram:update",
		[
			"updateTelegramBotFn",
			"updateTelegramDefaultsFn",
			"updateTelegramNotificationBindingFn",
			"setTelegramNotificationEnabledFn",
			"setTelegramCommandEnabledFn",
			"updateTelegramCommandFn",
			"setTelegramBotEnabledFn",
			"testTelegramBotFn",
			"syncTelegramCommandsFn",
		],
	],
	[
		"telegram:delete",
		[
			"deleteTelegramNotificationBindingFn",
			"deleteTelegramCommandFn",
			"deleteTelegramBotFn",
		],
	],
] as const;

const merchantApiEntries = [
	{
		route: "src/routes/payments/gmpay/v1/order/create-transaction.ts",
		handler: "src/features/orders/server/gmpay-api.ts",
		handlerName: "handleGmpayCreateRequest",
		authenticator: "authenticateGmpayCreate",
	},
	{
		route:
			"src/routes/payments/epay/v1/order/create-transaction/submit[.]php.ts",
		handler: "src/features/orders/server/epay-adapter.ts",
		handlerName: "handleEpayCreateRequest",
		authenticator: "authenticateEpayInput",
	},
	{
		route: "src/routes/payments/epay/v1/order/create-transaction/mapi[.]php.ts",
		handler: "src/features/orders/server/epay-adapter.ts",
		handlerName: "handleEpayMApiRequest",
		authenticator: "authenticateEpayInput",
	},
	{
		route: "src/routes/payments/epay/v1/order/create-transaction/api[.]php.ts",
		handler: "src/features/orders/server/epay-adapter.ts",
		handlerName: "handleEpayQueryRequest",
		authenticator: "authenticateEpayParameters",
	},
] as const;

describe("server entry authorization coverage", () => {
	it("classifies every Server Function as protected admin or reviewed public", () => {
		const discovered = sourceFiles(resolve(root, "src"))
			.filter((file) => readFileSync(file, "utf8").includes("createServerFn"))
			.map((file) => file.slice(root.length + 1))
			.sort();
		expect(discovered).toEqual(
			[...adminServerModules, ...reviewedPublicServerModules].sort(),
		);
	});

	it("keeps every admin Server Function behind dynamic RBAC", () => {
		for (const file of adminServerModules) {
			const source = read(file);
			expect(source, file).toMatch(
				/requireAdmin|adminContext|getAdminServerContext|telegramAdminContext/,
			);
			expect(source, file).toMatch(
				/systemPermission|paymentSettingsPermission/,
			);
			for (const declaration of serverFunctionDeclarations(file, source)) {
				expect(
					containsIdentifier(declaration, adminOwnerFunctions),
					`${file}:${declaration.name.getText()} has no authorization owner`,
				).toBe(true);
			}
		}
	});

	it("maps every admin Server Function to its exact module and action", () => {
		const actual = new Map<string, string>();
		for (const file of adminServerModules) {
			for (const declaration of serverFunctionDeclarations(file, read(file))) {
				const name = declaration.name.getText();
				expect(actual.has(name), `${name} is declared more than once`).toBe(
					false,
				);
				actual.set(name, permissionSignature(declaration));
			}
		}
		const expected = new Map(
			permissionContracts.flatMap(([permission, functions]) =>
				functions.map((name) => [name, permission] as const),
			),
		);
		expect(Object.fromEntries([...actual].sort())).toEqual(
			Object.fromEntries([...expected].sort()),
		);
	});

	it("declares every Server Function method and validates every input mutation", () => {
		for (const file of [
			...adminServerModules,
			...reviewedPublicServerModules,
		]) {
			const source = read(file);
			const declarations = [
				...source.matchAll(
					/export const (\w+) = createServerFn\(\s*\{\s*method: "(GET|POST)"\s*,?\s*\}\s*\)([\s\S]*?)(?=\nexport const |\n(?:async )?function |\nconst \w+ = |$)/g,
				),
			];
			expect(declarations.length, file).toBe(
				[...source.matchAll(/createServerFn\s*\(/g)].length,
			);
			for (const [, name, method, body] of declarations) {
				if (
					method === "POST" &&
					!reviewedInputlessPostFunctions.has(name ?? "")
				)
					expect(body, `${file}:${name}`).toContain(".validator(");
			}
		}
	});

	it("keeps every GET Server Function attached to a reviewed route or query owner", () => {
		const files = sourceFiles(resolve(root, "src"));
		for (const file of [
			...adminServerModules,
			...reviewedPublicServerModules,
		]) {
			const source = read(file);
			for (const declaration of serverFunctionDeclarations(file, source)) {
				if (!declaration.initializer?.getText().includes('method: "GET"'))
					continue;
				const name = declaration.name.getText();
				const consumers = files.filter((candidate) => {
					const relative = candidate.slice(root.length + 1);
					return (
						relative !== file &&
						!relative.includes("/server/") &&
						new RegExp(`\\b${name}\\b`).test(readFileSync(candidate, "utf8"))
					);
				});
				expect(
					consumers.length,
					`${file}:${name} has no route or query owner`,
				).toBeGreaterThan(0);
			}
		}
	});

	it("never renders arbitrary error.message in presentation modules", () => {
		const presentationFiles = sourceFiles(resolve(root, "src")).filter(
			(file) =>
				/[\\/](?:components|layouts|pages|routes)[\\/]/.test(file) &&
				!file.includes("/server/"),
		);
		for (const file of presentationFiles) {
			expect(readFileSync(file, "utf8"), file).not.toMatch(
				/(?:error|result\.error)\.message/,
			);
		}
	});

	it("installs one global Server Function error boundary", () => {
		const entry = read("src/server-entry.ts");
		expect(entry).toContain(
			"functionMiddleware: [serverFunctionErrorMiddleware]",
		);
	});

	it("checks only the strict binding-free liveness path before authority", () => {
		const entry = read("src/server-entry.ts");
		expect(entry.indexOf("handleLivenessRequest(request)")).toBeGreaterThan(-1);
		expect(entry.indexOf("handleLivenessRequest(request)")).toBeLessThan(
			entry.indexOf("validateRequestAuthority(request, env.DB)"),
		);
		expect(entry).toContain("applySecurityHeaders(");
	});

	it("authenticates every GMPay and EPay merchant entry route", () => {
		for (const entry of merchantApiEntries) {
			expect(read(entry.route), entry.route).toContain(entry.handlerName);
			expect(read(entry.handler), entry.handler).toContain(entry.authenticator);
		}
	});

	it("protects the admin evidence download at the route boundary", () => {
		expect(
			read("src/routes/api/admin/payment-reviews/$reviewId/evidence.ts"),
		).toContain('systemPermission("payment_reviews", "read")');
	});

	it("does not mutate runtime configuration from public install or auth reads", () => {
		for (const file of [
			"src/features/installation/server/functions.ts",
			"src/features/auth/server/auth.ts",
		]) {
			expect(read(file), file).not.toContain("initializeMissingRuntimeConfig");
		}
	});
});

function read(file: string) {
	return readFileSync(resolve(root, file), "utf8");
}

function sourceFiles(directory: string): string[] {
	return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
		const path = resolve(directory, entry.name);
		if (entry.isDirectory()) return sourceFiles(path);
		return entry.isFile() && /\.(?:ts|tsx)$/.test(entry.name) ? [path] : [];
	});
}

function serverFunctionDeclarations(file: string, source: string) {
	const sourceFile = ts.createSourceFile(
		file,
		source,
		ts.ScriptTarget.Latest,
		true,
		ts.ScriptKind.TS,
	);
	return sourceFile.statements.flatMap((statement) =>
		ts.isVariableStatement(statement)
			? statement.declarationList.declarations.filter((declaration) =>
					declaration.initializer?.getText().includes("createServerFn"),
				)
			: [],
	);
}

function containsIdentifier(
	node: ts.Node,
	names: ReadonlySet<string>,
): boolean {
	if (ts.isIdentifier(node) && names.has(node.text)) return true;
	return node.getChildren().some((child) => containsIdentifier(child, names));
}

function permissionSignature(node: ts.Node): string {
	if (
		ts.isCallExpression(node) &&
		ts.isIdentifier(node.expression) &&
		["systemPermission", "paymentSettingsPermission"].includes(
			node.expression.text,
		)
	) {
		const [first, second] = node.arguments;
		const module =
			node.expression.text === "paymentSettingsPermission"
				? "payment_settings"
				: literalText(first);
		const action = actionText(
			node.expression.text === "paymentSettingsPermission" ? first : second,
		);
		return `${module}:${action}`;
	}
	for (const child of node.getChildren()) {
		const signature = permissionSignatureOrUndefined(child);
		if (signature) return signature;
	}
	throw new Error(
		`${node.getSourceFile().fileName} has no permission expression`,
	);
}

function permissionSignatureOrUndefined(node: ts.Node): string | undefined {
	try {
		return permissionSignature(node);
	} catch {
		return undefined;
	}
}

function actionText(node: ts.Expression | undefined): string {
	if (node && ts.isConditionalExpression(node))
		return [literalText(node.whenTrue), literalText(node.whenFalse)]
			.sort()
			.join("|");
	return literalText(node);
}

function literalText(node: ts.Expression | undefined): string {
	if (node && ts.isStringLiteral(node)) return node.text;
	throw new Error("Permission modules and actions must use explicit literals");
}
