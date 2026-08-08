CREATE TABLE `payment_ingress_credentials` (
	`payment_ingress_id` text PRIMARY KEY NOT NULL,
	`config_encrypted` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`payment_ingress_id`) REFERENCES `payment_ingresses`(`id`) ON UPDATE no action ON DELETE cascade
);
