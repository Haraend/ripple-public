CREATE TABLE `guild_settings` (
	`guild_id` text PRIMARY KEY NOT NULL,
	`apex_channel_id` text,
	`dj_role_id` text,
	`dj_mode_enabled` integer DEFAULT false NOT NULL,
	`music_enabled` integer DEFAULT true NOT NULL,
	`default_volume` integer DEFAULT 100 NOT NULL,
	`max_queue_size` integer DEFAULT 100 NOT NULL,
	`updated_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL
);
