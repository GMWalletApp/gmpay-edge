import { Miniflare } from "miniflare";
import {
	afterAll,
	afterEach,
	beforeAll,
	describe,
	expect,
	it,
	vi,
} from "vitest";
import {
	loadRateSyncConfiguration,
	saveRateSyncConfiguration,
} from "#/features/payment-settings/server/exchange-rates";
import { saveRateSyncSettingsFn } from "#/features/payment-settings/server/rate-functions";
import { applyMigrations } from "./migrations";

// The settings server function runs as a plain handler here (same pattern as
// the public status functions): the Start RPC wrapper and the admin session
// belong to the framework, while the provider/credential rules under test live
// in the handler body.
vi.mock("@tanstack/react-start", () => ({
	createServerFn: () => ({
		validator: (validate: unknown) => ({
			handler:
				(handler: (args: { data: unknown }) => unknown) => (input: unknown) =>
					handler({ data: (validate as (input: unknown) => unknown)(input) }),
		}),
	}),
	createServerOnlyFn: (fn: unknown) => fn,
}));

const mocks = vi.hoisted(() => ({
	context: null as null | {
		db: D1Database;
		user: { id: string };
		request: Request;
	},
}));
vi.mock("#/features/payment-settings/server/admin-context", () => ({
	adminContext: async () => {
		if (!mocks.context) throw new Error("admin context not initialised");
		return mocks.context;
	},
}));

const save = saveRateSyncSettingsFn as unknown as (input: {
	category: "fiat";
	enabled: boolean;
	provider: "exchangerate_host" | "allratestoday";
	intervalMs: number;
	adjustmentBps: number;
	apiKey?: string;
	runNow?: boolean;
}) => Promise<unknown>;

const base = {
	category: "fiat" as const,
	enabled: true,
	intervalMs: 86_400_000,
	adjustmentBps: 0,
};

describe("rate sync settings server function (fiat provider switching)", () => {
	let miniflare: Miniflare;
	let db: D1Database;

	beforeAll(async () => {
		miniflare = new Miniflare({
			modules: true,
			script: "export default { fetch() { return new Response('ok') } }",
			d1Databases: { DB: "gmpay-edge-rate-sync-settings" },
		});
		db = await miniflare.getD1Database("DB");
		await applyMigrations(db);
		await db
			.prepare(
				"INSERT INTO users (id, name, email, email_verified, enabled, two_factor_enabled, created_at, updated_at) VALUES ('admin-1', 'Rates admin', 'rates-admin@example.com', 1, 1, 0, ?, ?)",
			)
			.bind(Date.now(), Date.now())
			.run();
		mocks.context = {
			db,
			user: { id: "admin-1" },
			request: new Request("https://pay.example/admin/rates", {
				headers: { "cf-connecting-ip": "203.0.113.9" },
			}),
		};
	});
	afterAll(async () => miniflare.dispose());
	afterEach(async () => {
		vi.restoreAllMocks();
		await db
			.prepare("DELETE FROM system_settings WHERE key = 'rates.fiat_sync'")
			.run();
		await db
			.prepare(
				"DELETE FROM audit_logs WHERE action = 'rate_sync.settings_updated'",
			)
			.run();
	});

	it("still requires an API key for exchangerate.host when none is stored", async () => {
		await expect(
			save({ ...base, provider: "exchangerate_host" }),
		).rejects.toMatchObject({ code: "fiat_rate_credentials_required" });
		const stored = await loadRateSyncConfiguration(db, "fiat");
		expect(stored.provider).toBe("exchangerate_host");
		expect(stored.credentials.apiKey).toBe("");
	});

	it("saves the keyless provider without a key and reports no credentials", async () => {
		await expect(save({ ...base, provider: "allratestoday" })).resolves.toEqual(
			{
				saved: true,
				hasCredentials: false,
			},
		);
		const stored = await loadRateSyncConfiguration(db, "fiat");
		expect(stored).toMatchObject({
			provider: "allratestoday",
			credentials: { apiKey: "" },
		});
		const audit = await db
			.prepare(
				"SELECT after FROM audit_logs WHERE action = 'rate_sync.settings_updated'",
			)
			.first<{ after: string }>();
		expect(JSON.parse(audit?.after ?? "{}")).toMatchObject({
			provider: "allratestoday",
			credentialsChanged: false,
		});
	});

	it("switching back to exchangerate.host without a stored key is refused and leaves the keyless provider saved", async () => {
		await save({ ...base, provider: "allratestoday" });
		await expect(
			save({ ...base, provider: "exchangerate_host" }),
		).rejects.toMatchObject({ code: "fiat_rate_credentials_required" });
		expect((await loadRateSyncConfiguration(db, "fiat")).provider).toBe(
			"allratestoday",
		);
	});

	it("keeps an existing exchangerate.host key across a switch to the keyless provider and back", async () => {
		await expect(
			save({ ...base, provider: "exchangerate_host", apiKey: "secret-key" }),
		).resolves.toEqual({ saved: true, hasCredentials: true });

		// The key field is hidden while AllRatesToday is selected, so the form
		// submits no apiKey; the stored credential must survive untouched.
		await expect(save({ ...base, provider: "allratestoday" })).resolves.toEqual(
			{
				saved: true,
				hasCredentials: true,
			},
		);
		expect(await loadRateSyncConfiguration(db, "fiat")).toMatchObject({
			provider: "allratestoday",
			credentials: { apiKey: "secret-key" },
		});

		// Switching back needs no re-entry of the key.
		await expect(
			save({ ...base, provider: "exchangerate_host" }),
		).resolves.toEqual({
			saved: true,
			hasCredentials: true,
		});
		expect(await loadRateSyncConfiguration(db, "fiat")).toMatchObject({
			provider: "exchangerate_host",
			credentials: { apiKey: "secret-key" },
		});
		const audits = await db
			.prepare(
				"SELECT after FROM audit_logs WHERE action = 'rate_sync.settings_updated' ORDER BY created_at",
			)
			.all<{ after: string }>();
		expect(
			audits.results.map((row) => JSON.parse(row.after).credentialsChanged),
		).toEqual([true, false, false]);
	});

	it("runs the keyless provider immediately without a key when asked to", async () => {
		vi.spyOn(console, "info").mockImplementation(() => undefined);
		const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
			Response.json({
				result: "success",
				base_code: "USD",
				time_last_update_unix: Math.floor(Date.now() / 1000) - 3_600,
				rates: { USD: 1, EUR: 0.86 },
			}),
		);
		await expect(
			save({ ...base, provider: "allratestoday", runNow: true }),
		).resolves.toMatchObject({ failed: 0 });
		expect(fetchSpy).toHaveBeenCalledTimes(1);
		expect(String(fetchSpy.mock.calls[0]?.[0])).toBe(
			"https://allratestoday.com/api/open/latest/USD",
		);
		expect(await loadRateSyncConfiguration(db, "fiat")).toMatchObject({
			provider: "allratestoday",
		});
	});

	it("does not reach the provider when exchangerate.host is selected without a key, even with run now", async () => {
		await saveRateSyncConfiguration(
			db,
			"fiat",
			{
				enabled: true,
				provider: "allratestoday",
				intervalMs: 86_400_000,
				adjustmentBps: 0,
				credentials: { apiKey: "" },
				lastSyncedAt: null,
			},
			"admin-1",
		);
		const fetchSpy = vi.spyOn(globalThis, "fetch");
		await expect(
			save({ ...base, provider: "exchangerate_host", runNow: true }),
		).rejects.toMatchObject({ code: "fiat_rate_credentials_required" });
		expect(fetchSpy).not.toHaveBeenCalled();
	});
});
