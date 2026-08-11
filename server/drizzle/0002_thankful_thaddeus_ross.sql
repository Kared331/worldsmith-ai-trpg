CREATE TABLE `gm_outcomes` (
	`id` text PRIMARY KEY NOT NULL,
	`gm_message_id` text NOT NULL,
	`skill_name` text NOT NULL,
	`skill_args` text NOT NULL,
	`code_result` text NOT NULL,
	`gm_narrative` text NOT NULL,
	`player_choice` text DEFAULT 'gm' NOT NULL,
	`player_custom` text,
	`created_at` text NOT NULL,
	FOREIGN KEY (`gm_message_id`) REFERENCES `gm_messages`(`id`) ON UPDATE no action ON DELETE cascade
);
