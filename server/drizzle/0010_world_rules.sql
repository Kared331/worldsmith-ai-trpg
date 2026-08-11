CREATE TABLE `world_rules` (
	`id` text PRIMARY KEY NOT NULL,
	`title` text NOT NULL,
	`content` text NOT NULL,
	`category` text DEFAULT 'other' NOT NULL,
	`author` text DEFAULT 'player' NOT NULL,
	`enabled` integer DEFAULT 1 NOT NULL,
	`world_id` text DEFAULT 'default-world' NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`world_id`) REFERENCES `worlds`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `world_rules_world_idx` ON `world_rules` (`world_id`);
