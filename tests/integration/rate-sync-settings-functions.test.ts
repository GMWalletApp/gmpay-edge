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
import { quoteUsdAmountMinor } from "#/features/payment-settings/server/rates";
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
	publicationValidityMs?: number;
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
		await db
			.prepare(
				"DELETE FROM exchange_rates WHERE quote IN ('EUR', 'GBP', 'JPY')",
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
			publicationValidityMs: 86_400_000,
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
			publicationValidityMs: 86_400_000,
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
			publicationValidityMs: 86_400_000,
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

	it("defaults the AllRatesToday validity to 24h, stores a configured duration and audits it", async () => {
		await expect(save({ ...base, provider: "allratestoday" })).resolves.toEqual(
			{ saved: true, hasCredentials: false },
		);
		expect(await loadRateSyncConfiguration(db, "fiat")).toMatchObject({
			provider: "allratestoday",
			publicationValidityMs: 86_400_000,
		});
		await expect(
			save({
				...base,
				provider: "allratestoday",
				publicationValidityMs: 72 * 3_600_000,
			}),
		).resolves.toEqual({ saved: true, hasCredentials: false });
		expect(await loadRateSyncConfiguration(db, "fiat")).toMatchObject({
			publicationValidityMs: 72 * 3_600_000,
		});
		const audits = await db
			.prepare(
				"SELECT after FROM audit_logs WHERE action = 'rate_sync.settings_updated' ORDER BY created_at",
			)
			.all<{ after: string }>();
		expect(
			audits.results.map((row) => JSON.parse(row.after).publicationValidityMs),
		).toEqual([86_400_000, 72 * 3_600_000]);
	});

	it("rejects an AllRatesToday validity outside 1h..7d at the server boundary and keeps the stored duration", async () => {
		await save({
			...base,
			provider: "allratestoday",
			publicationValidityMs: 48 * 3_600_000,
		});
		// The input schema rejects before the handler runs (synchronously in
		// this plain-handler harness), so the refusal is awaited through a
		// promise.
		for (const publicationValidityMs of [
			0,
			3_600_000 - 1,
			7 * 86_400_000 + 1,
			1.5 * 3_600_000 + 0.5,
			-86_400_000,
		])
			await expect(
				Promise.resolve().then(() =>
					save({ ...base, provider: "allratestoday", publicationValidityMs }),
				),
			).rejects.toThrow(/Too (small|big)|expected int/);
		expect(await loadRateSyncConfiguration(db, "fiat")).toMatchObject({
			publicationValidityMs: 48 * 3_600_000,
		});
		// The bounds themselves are accepted.
		await expect(
			save({
				...base,
				provider: "allratestoday",
				publicationValidityMs: 3_600_000,
			}),
		).resolves.toMatchObject({ saved: true });
		await expect(
			save({
				...base,
				provider: "allratestoday",
				publicationValidityMs: 7 * 86_400_000,
			}),
		).resolves.toMatchObject({ saved: true });
		// A stored out-of-range value (e.g. hand-edited) reads back as 24h.
		await db
			.prepare(
				"UPDATE system_settings SET value = ? WHERE key = 'rates.fiat_sync'",
			)
			.bind(
				JSON.stringify({
					enabled: true,
					provider: "allratestoday",
					intervalMs: 86_400_000,
					adjustmentBps: 0,
					publicationValidityMs: 30 * 86_400_000,
					credentials: { apiKey: "" },
					lastSyncedAt: null,
				}),
			)
			.run();
		expect(await loadRateSyncConfiguration(db, "fiat")).toMatchObject({
			publicationValidityMs: 86_400_000,
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
				publicationValidityMs: 86_400_000,
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

	describe("shortening the AllRatesToday validity", () => {
		const hour = 3_600_000;
		const published = 1_900_000_000_000;
		const allRatesToday = { ...base, provider: "allratestoday" as const };

		function providerServes(response: () => Response) {
			return vi
				.spyOn(globalThis, "fetch")
				.mockImplementation(async () => response());
		}
		const publication = () =>
			Response.json({
				result: "success",
				base_code: "USD",
				rates: { EUR: 0.9 },
				time_last_update_unix: published / 1000,
			});
		function at(time: number) {
			vi.spyOn(Date, "now").mockReturnValue(time);
			return time;
		}
		const stored = () =>
			db
				.prepare(
					"SELECT observed_at, expires_at FROM exchange_rates WHERE category = 'fiat' AND quote = 'EUR'",
				)
				.first<{ observed_at: number; expires_at: number }>();
		const quote = (now: number) =>
			quoteUsdAmountMinor(db, { amount: "100", currency: "EUR", now });

		// Accepted at 72h, then 30 hours old: outside a 24h validity.
		async function storedAt72h() {
			const fetchSpy = providerServes(publication);
			at(published + hour);
			await expect(
				save({
					...allRatesToday,
					publicationValidityMs: 72 * hour,
					runNow: true,
				}),
			).resolves.toMatchObject({ updated: 1, failed: 0 });
			const now = at(published + 30 * hour);
			expect(await quote(now)).not.toBeNull();
			return { fetchSpy, now };
		}
		const shortened = {
			observed_at: published,
			expires_at: published + 24 * hour,
		};

		it("withdraws the stored publication on save, without contacting the provider", async () => {
			const { fetchSpy, now } = await storedAt72h();
			fetchSpy.mockClear();

			await save({ ...allRatesToday, publicationValidityMs: 24 * hour });

			expect(fetchSpy).not.toHaveBeenCalled();
			expect(await stored()).toEqual(shortened);
			expect(await quote(now)).toBeNull();
		});

		it("withdraws it when run now gets the same, now expired, publication", async () => {
			const { now } = await storedAt72h();

			await expect(
				save({
					...allRatesToday,
					publicationValidityMs: 24 * hour,
					runNow: true,
				}),
			).resolves.toMatchObject({ updated: 0, failed: 1 });

			expect(await stored()).toEqual(shortened);
			expect(await quote(now)).toBeNull();
		});

		it("withdraws it when the provider fails after shortening", async () => {
			const { fetchSpy, now } = await storedAt72h();
			fetchSpy.mockImplementation(
				async () => new Response("unavailable", { status: 503 }),
			);

			await expect(
				save({
					...allRatesToday,
					publicationValidityMs: 24 * hour,
					runNow: true,
				}),
			).resolves.toMatchObject({ updated: 0, failed: 1 });

			expect(await stored()).toEqual(shortened);
			expect(await quote(now)).toBeNull();
		});

		it("keeps a publication quotable until the exact new boundary", async () => {
			await storedAt72h();
			const boundary = published + 24 * hour;
			at(boundary - 1);

			await save({ ...allRatesToday, publicationValidityMs: 24 * hour });

			expect(await stored()).toEqual(shortened);
			expect(await quote(boundary - 1)).not.toBeNull();
			expect(await quote(boundary)).toBeNull();
		});

		it("leaves a longer validity to the next sync", async () => {
			providerServes(publication);
			at(published + hour);
			await save({ ...allRatesToday, runNow: true });
			expect(await stored()).toEqual(shortened);

			await save({ ...allRatesToday, publicationValidityMs: 72 * hour });

			expect(await stored()).toEqual(shortened);
		});

		it("does not touch other providers, crypto or manual overrides", async () => {
			const manualExpiry = published + 3_650 * 24 * hour;
			const rows = [
				["fiat", "GBP", "exchangerate_host", published + 72 * hour],
				["crypto", "JPY", "allratestoday", published + 72 * hour],
				["fiat", "JPY", "allratestoday", manualExpiry],
			] as const;
			for (const [category, quoteCurrency, source, expiresAt] of rows)
				await db
					.prepare(
						`INSERT INTO exchange_rates
						 (id, category, base, quote, raw_rate, rate, source, adjustment_bps,
						  observed_at, expires_at, created_at, updated_at)
						 VALUES (?, ?, 'USD', ?, '1', '1', ?, 0, ?, ?, ?, ?)`,
					)
					.bind(
						`${category}-${quoteCurrency}-${source}`,
						category,
						quoteCurrency,
						source,
						published,
						expiresAt,
						published,
						published,
					)
					.run();
			at(published + 30 * hour);

			await save({ ...allRatesToday, publicationValidityMs: 24 * hour });

			const after = await db
				.prepare(
					"SELECT expires_at FROM exchange_rates WHERE quote IN ('GBP', 'JPY') ORDER BY category DESC, quote",
				)
				.all<{ expires_at: number }>();
			expect(after.results.map((row) => row.expires_at).sort()).toEqual(
				rows.map((row) => row[3]).sort(),
			);
		});
	});
});
