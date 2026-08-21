import { sql } from "drizzle-orm";
import {
	index,
	integer,
	sqliteTable,
	text,
	uniqueIndex,
} from "drizzle-orm/sqlite-core";
import { users } from "./auth";
import { timestamps } from "./common";

export const systemSettings = sqliteTable("system_settings", {
	key: text("key").primaryKey(),
	value: text("value", { mode: "json" }).$type<unknown>().notNull(),
	isSecret: integer("is_secret", { mode: "boolean" }).notNull().default(false),
	updatedBy: text("updated_by").references(() => users.id, {
		onDelete: "set null",
	}),
	...timestamps,
});

export const emailChannelConfigs = sqliteTable(
	"email_channel_configs",
	{
		id: text("id").primaryKey(),
		name: text("name").notNull(),
		provider: text("provider", {
			enum: [
				"resend",
				"postmark",
				"sendgrid",
				"mailgun",
				"smtp",
				"cloudflare_email",
			],
		}).notNull(),
		credentialEncrypted: text("credential_encrypted"),
		domain: text("domain"),
		region: text("region", { enum: ["us", "eu"] })
			.notNull()
			.default("us"),
		smtpHost: text("smtp_host"),
		smtpPort: integer("smtp_port"),
		smtpUser: text("smtp_user"),
		fromAddress: text("from_address").notNull(),
		replyTo: text("reply_to"),
		sortOrder: integer("sort_order").notNull().default(100),
		enabled: integer("enabled", { mode: "boolean" }).notNull().default(false),
		...timestamps,
	},
	(table) => [
		uniqueIndex("email_channel_configs_name_uidx").on(table.name),
		index("email_channel_configs_delivery_idx").on(
			table.enabled,
			table.sortOrder,
			table.id,
		),
	],
);

export const auditLogs = sqliteTable(
	"audit_logs",
	{
		id: text("id").primaryKey(),
		actorUserId: text("actor_user_id").references(() => users.id, {
			onDelete: "set null",
		}),
		action: text("action").notNull(),
		targetType: text("target_type").notNull(),
		targetId: text("target_id"),
		requestId: text("request_id"),
		ipAddress: text("ip_address"),
		before: text("before", { mode: "json" }).$type<Record<string, unknown>>(),
		after: text("after", { mode: "json" }).$type<Record<string, unknown>>(),
		createdAt: integer("created_at", { mode: "timestamp_ms" })
			.notNull()
			.default(sql`(unixepoch() * 1000)`),
	},
	(table) => [index("audit_logs_created_idx").on(table.createdAt, table.id)],
);

export const auditExports = sqliteTable(
	"audit_exports",
	{
		id: text("id").primaryKey(),
		objectKey: text("object_key").notNull().unique(),
		exportedBy: text("exported_by").references(() => users.id, {
			onDelete: "set null",
		}),
		recordCount: integer("record_count").notNull(),
		deleteAfter: integer("delete_after", { mode: "timestamp_ms" }).notNull(),
		deletedAt: integer("deleted_at", { mode: "timestamp_ms" }),
		...timestamps,
	},
	(table) => [
		index("audit_exports_retention_idx")
			.on(table.deleteAfter, table.id)
			.where(sql`${table.deletedAt} IS NULL`),
	],
);

export const operationTaskRuns = sqliteTable(
	"operation_task_runs",
	{
		id: text("id").primaryKey(),
		task: text("task").notNull(),
		trigger: text("trigger", { enum: ["manual", "scheduled"] }).notNull(),
		schedule: text("schedule"),
		status: text("status", { enum: ["running", "succeeded", "failed"] })
			.notNull()
			.default("running"),
		startedAt: integer("started_at", { mode: "timestamp_ms" }).notNull(),
		completedAt: integer("completed_at", { mode: "timestamp_ms" }),
		durationMs: integer("duration_ms"),
		errorCode: text("error_code"),
		result: text("result", { mode: "json" }).$type<Record<string, unknown>>(),
	},
	(table) => [
		index("operation_task_runs_task_started_idx").on(
			table.task,
			table.startedAt,
		),
		index("operation_task_runs_retention_idx")
			.on(table.completedAt, table.id)
			.where(sql`${table.status} IN ('succeeded', 'failed')`),
	],
);
