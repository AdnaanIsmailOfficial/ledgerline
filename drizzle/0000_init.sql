CREATE TABLE `audit_records` (
	`seq` integer PRIMARY KEY NOT NULL,
	`id` text NOT NULL,
	`ts` text NOT NULL,
	`app_id` text NOT NULL,
	`user_id` text NOT NULL,
	`provider` text NOT NULL,
	`mock` integer NOT NULL,
	`model` text NOT NULL,
	`decision` text NOT NULL,
	`rules_fired` text NOT NULL,
	`prompt_hash` text NOT NULL,
	`redacted_prompt_hash` text NOT NULL,
	`response_hash` text,
	`input_tokens` integer NOT NULL,
	`output_tokens` integer NOT NULL,
	`cost_micros` integer NOT NULL,
	`latency_ms` integer NOT NULL,
	`status` text NOT NULL,
	`error_code` text,
	`prev_hash` text NOT NULL,
	`record_hash` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `audit_records_id_unique` ON `audit_records` (`id`);--> statement-breakpoint
CREATE INDEX `idx_audit_app_user_ts` ON `audit_records` (`app_id`,`user_id`,`ts`);--> statement-breakpoint
CREATE INDEX `idx_audit_ts` ON `audit_records` (`ts`);--> statement-breakpoint
CREATE TABLE `checkpoints` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`from_seq` integer NOT NULL,
	`to_seq` integer NOT NULL,
	`merkle_root` text NOT NULL,
	`created_at` text NOT NULL,
	`anchor_tx_hash` text,
	`anchor_chain` text
);
--> statement-breakpoint
CREATE UNIQUE INDEX `checkpoints_to_seq_unique` ON `checkpoints` (`to_seq`);--> statement-breakpoint
CREATE TABLE `record_payloads` (
	`record_id` text PRIMARY KEY NOT NULL,
	`prompt_redacted` text NOT NULL,
	`response_text` text,
	FOREIGN KEY (`record_id`) REFERENCES `audit_records`(`id`) ON UPDATE no action ON DELETE no action
);
