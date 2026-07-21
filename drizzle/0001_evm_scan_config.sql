ALTER TABLE `payment_ingresses` ADD `timeout_ms` integer;--> statement-breakpoint
ALTER TABLE `payment_ingresses` ADD `block_lookback` integer;--> statement-breakpoint
ALTER TABLE `payment_ingresses` ADD `log_block_range` integer;--> statement-breakpoint
ALTER TABLE `payment_ingresses` ADD `max_scan_transactions` integer;