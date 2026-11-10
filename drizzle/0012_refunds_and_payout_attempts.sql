CREATE TABLE `payout_attempts` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`refund_id` integer NOT NULL,
	`sent_at` text NOT NULL,
	`settled_at` text,
	`result` text,
	`failure_reason` text,
	FOREIGN KEY (`refund_id`) REFERENCES `refunds`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `payout_attempts_refund_idx` ON `payout_attempts` (`refund_id`);--> statement-breakpoint
CREATE TABLE `refunds` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`refund_request_id` integer NOT NULL,
	`amount` integer NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`refund_request_id`) REFERENCES `refund_requests`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `refunds_refund_request_id_unique` ON `refunds` (`refund_request_id`);--> statement-breakpoint
ALTER TABLE `refund_requests` ADD `decision_note` text;