import { describe, expect, it } from "vitest";
import {
	formatScheduleInterval,
	nextTaskExecutionAt,
	scheduledTaskCatalog,
} from "#/features/operations/schedule";

describe("operations task schedules", () => {
	it("orders tasks by operational priority", () => {
		expect(scheduledTaskCatalog).toEqual([
			{ task: "order_expiration", manual: true },
			{ task: "webhook_outbox", manual: true },
			{ task: "rpc_health", manual: true },
			{ task: "crypto_rate_sync", manual: true },
			{ task: "fiat_rate_sync", manual: true },
			{ task: "payment_defaults", manual: true },
			{ task: "payment_scan_enqueue", manual: false },
			{ task: "frequent_cleanup", manual: false },
			{ task: "retention_cleanup", manual: false },
		]);
		expect(scheduledTaskCatalog.map(({ task }) => task)).toEqual([
			"order_expiration",
			"webhook_outbox",
			"rpc_health",
			"crypto_rate_sync",
			"fiat_rate_sync",
			"payment_defaults",
			"payment_scan_enqueue",
			"frequent_cleanup",
			"retention_cleanup",
		]);
	});

	it("formats operator-facing schedules as localized durations", () => {
		expect(formatScheduleInterval(60_000, "en-US")).toBe("1 minute");
		expect(formatScheduleInterval(300_000, "en-US")).toBe("5 minutes");
		expect(formatScheduleInterval(86_400_000, "en-US")).toBe("1 day");
		expect(formatScheduleInterval(60_000, "ja-JP")).toBe("1分");
		expect(formatScheduleInterval(60_000, "ko-KR")).toBe("1분");
		expect(formatScheduleInterval(60_000, "ru-RU")).toBe("1 минута");
		expect(formatScheduleInterval(300_000, "ru-RU")).toBe("5 минут");
		expect(formatScheduleInterval(60_000, "zh-TW")).toBe("1分鐘");
		expect(formatScheduleInterval(60_000, "zh-CN")).toBe("1分钟");
	});

	const now = Date.parse("2026-07-13T02:30:30.000Z");

	it("computes the next minute schedule and the five-minute retention schedule", () => {
		expect(nextTaskExecutionAt("order_expiration", null, rates, now)).toBe(
			"2026-07-13T02:31:00.000Z",
		);
		expect(nextTaskExecutionAt("retention_cleanup", null, rates, now)).toBe(
			"2026-07-13T02:35:00.000Z",
		);
		expect(
			nextTaskExecutionAt(
				"retention_cleanup",
				null,
				rates,
				Date.parse("2026-07-13T00:00:00.000Z"),
			),
		).toBe("2026-07-13T00:05:00.000Z");
	});

	it("uses each category's persisted rate interval", () => {
		expect(
			nextTaskExecutionAt(
				"crypto_rate_sync",
				"2026-07-13T02:29:00.000Z",
				rates,
				now,
			),
		).toBe("2026-07-13T02:34:00.000Z");
		expect(
			nextTaskExecutionAt("payment_defaults", null, rates, now),
		).toBeNull();
	});
});

const rates = { crypto: 300_000, fiat: 86_400_000 };
