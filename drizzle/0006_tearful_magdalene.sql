CREATE TABLE `email_channel_configs` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`provider` text NOT NULL,
	`credential_encrypted` text,
	`domain` text,
	`region` text DEFAULT 'us' NOT NULL,
	`smtp_host` text,
	`smtp_port` integer,
	`smtp_user` text,
	`from_address` text NOT NULL,
	`reply_to` text,
	`sort_order` integer DEFAULT 100 NOT NULL,
	`enabled` integer DEFAULT false NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `email_channel_configs_name_uidx` ON `email_channel_configs` (`name`);--> statement-breakpoint
CREATE INDEX `email_channel_configs_delivery_idx` ON `email_channel_configs` (`enabled`,`sort_order`,`id`);