CREATE TABLE `group_members` (
	`id` text PRIMARY KEY NOT NULL,
	`conversation_id` text NOT NULL,
	`character_id` text NOT NULL,
	`join_order` integer DEFAULT 0 NOT NULL,
	FOREIGN KEY (`conversation_id`) REFERENCES `conversations`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`character_id`) REFERENCES `characters`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `group_members_conv_idx` ON `group_members` (`conversation_id`);