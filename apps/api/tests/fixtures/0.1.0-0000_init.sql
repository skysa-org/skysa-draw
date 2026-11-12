CREATE TABLE `storage_connections` (
	`id` text PRIMARY KEY NOT NULL,
	`provider` text NOT NULL,
	`account_id` text NOT NULL,
	`display_name` text NOT NULL,
	`root_id` text,
	`secret_ciphertext` text NOT NULL,
	`secret_iv` text NOT NULL,
	`secret_key_id` text NOT NULL,
	`created_at` integer NOT NULL,
	`last_used_at` integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX `storage_connections_provider_account_idx` ON `storage_connections` (`provider`,`account_id`);--> statement-breakpoint
CREATE TABLE `grants` (
	`id` text PRIMARY KEY NOT NULL,
	`connection_id` text,
	`secret_hash` text NOT NULL,
	`created_at` integer NOT NULL,
	`last_used_at` integer NOT NULL,
	`device` text,
	FOREIGN KEY (`connection_id`) REFERENCES `storage_connections`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `grants_secret_hash_idx` ON `grants` (`secret_hash`);--> statement-breakpoint
CREATE INDEX `grants_connection_id_idx` ON `grants` (`connection_id`);