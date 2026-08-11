CREATE TABLE `characters` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`personality` text DEFAULT '' NOT NULL,
	`background` text DEFAULT '' NOT NULL,
	`appearance` text,
	`first_message` text,
	`scenario` text,
	`tags` text DEFAULT '[]',
	`avatar` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `conversations` (
	`id` text PRIMARY KEY NOT NULL,
	`character_id` text NOT NULL,
	`mode` text DEFAULT 'chat' NOT NULL,
	`title` text,
	`created_at` text NOT NULL,
	FOREIGN KEY (`character_id`) REFERENCES `characters`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `conversations_character_idx` ON `conversations` (`character_id`);--> statement-breakpoint
CREATE TABLE `knowledge_entries` (
	`id` text PRIMARY KEY NOT NULL,
	`scope` text NOT NULL,
	`owner_id` text NOT NULL,
	`timestamp` text NOT NULL,
	`type` text NOT NULL,
	`content` text NOT NULL,
	`tags` text DEFAULT '[]',
	`importance` integer DEFAULT 3 NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `knowledge_owner_idx` ON `knowledge_entries` (`owner_id`);--> statement-breakpoint
CREATE TABLE `messages` (
	`id` text PRIMARY KEY NOT NULL,
	`conversation_id` text NOT NULL,
	`role` text NOT NULL,
	`content` text NOT NULL,
	`speaker_name` text,
	`created_at` text NOT NULL,
	FOREIGN KEY (`conversation_id`) REFERENCES `conversations`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `messages_conversation_idx` ON `messages` (`conversation_id`);