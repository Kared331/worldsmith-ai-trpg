CREATE TABLE `worlds` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`description` text DEFAULT '' NOT NULL,
	`sort_order` integer DEFAULT 0 NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
DROP INDEX `player_states_key_unique`;--> statement-breakpoint
ALTER TABLE `player_states` ADD `world_id` text DEFAULT 'default-world' NOT NULL REFERENCES worlds(id);--> statement-breakpoint
CREATE INDEX `player_states_world_idx` ON `player_states` (`world_id`);--> statement-breakpoint
CREATE INDEX `player_states_key_world_idx` ON `player_states` (`key`,`world_id`);--> statement-breakpoint
ALTER TABLE `characters` ADD `world_id` text REFERENCES worlds(id);--> statement-breakpoint
CREATE INDEX `characters_world_idx` ON `characters` (`world_id`);--> statement-breakpoint
ALTER TABLE `conversations` ADD `world_id` text DEFAULT 'default-world' NOT NULL REFERENCES worlds(id);--> statement-breakpoint
CREATE INDEX `conversations_world_idx` ON `conversations` (`world_id`);--> statement-breakpoint
ALTER TABLE `gm_messages` ADD `world_id` text DEFAULT 'default-world' NOT NULL REFERENCES worlds(id);--> statement-breakpoint
CREATE INDEX `gm_messages_world_idx` ON `gm_messages` (`world_id`);--> statement-breakpoint
ALTER TABLE `locations` ADD `world_id` text DEFAULT 'default-world' NOT NULL REFERENCES worlds(id);--> statement-breakpoint
CREATE INDEX `locations_world_idx` ON `locations` (`world_id`);--> statement-breakpoint
ALTER TABLE `lore_entries` ADD `world_id` text DEFAULT 'default-world' NOT NULL REFERENCES worlds(id);--> statement-breakpoint
CREATE INDEX `lore_entries_world_idx` ON `lore_entries` (`world_id`);