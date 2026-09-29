DROP INDEX `webhook_deliveries_outbox_idx`;--> statement-breakpoint
CREATE INDEX `webhook_deliveries_order_idx` ON `webhook_deliveries` (`order_id`);--> statement-breakpoint
CREATE INDEX `webhook_deliveries_outbox_idx` ON `webhook_deliveries` (`created_at`,`id`,`status`,`next_attempt_at`) WHERE "webhook_deliveries"."status" IN ('queued', 'failed', 'delivering');--> statement-breakpoint
CREATE INDEX `receiving_method_locks_order_idx` ON `receiving_method_locks` (`order_id`);--> statement-breakpoint
CREATE INDEX `webhook_events_order_idx` ON `webhook_events` (`order_id`);--> statement-breakpoint
UPDATE `order_payments` SET `status` = 'pending_review' WHERE `status` = 'detected' AND `order_id` IN (SELECT `id` FROM `orders` WHERE `status` IN ('expired', 'cancelled'));--> statement-breakpoint
DELETE FROM `system_settings` WHERE `key` = 'runtime.retention_schedule';
