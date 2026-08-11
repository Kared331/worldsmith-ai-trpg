CREATE TABLE `character_states` (
	`id` text PRIMARY KEY NOT NULL,
	`character_id` text NOT NULL,
	`key` text NOT NULL,
	`label` text NOT NULL,
	`value` text NOT NULL,
	`icon` text DEFAULT 'Activity' NOT NULL,
	`world_id` text DEFAULT 'default-world' NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`character_id`) REFERENCES `characters`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`world_id`) REFERENCES `worlds`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `character_states_world_idx` ON `character_states` (`world_id`);--> statement-breakpoint
CREATE INDEX `character_states_character_idx` ON `character_states` (`character_id`);--> statement-breakpoint
CREATE INDEX `character_states_key_char_world_idx` ON `character_states` (`key`,`character_id`,`world_id`);
