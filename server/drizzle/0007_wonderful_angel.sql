CREATE TABLE `player_states` (
	`id` text PRIMARY KEY NOT NULL,
	`key` text NOT NULL,
	`label` text NOT NULL,
	`value` text NOT NULL,
	`icon` text DEFAULT 'Activity' NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `player_states_key_unique` ON `player_states` (`key`);