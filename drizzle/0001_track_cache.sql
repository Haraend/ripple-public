CREATE TABLE `track_cache` (
	`source_key` text PRIMARY KEY NOT NULL,
	`webpage_url` text NOT NULL,
	`title` text NOT NULL,
	`duration_ms` integer,
	`stream_url` text NOT NULL,
	`codec` text NOT NULL,
	`stream_fetched_at` integer NOT NULL,
	`metadata_fetched_at` integer NOT NULL,
	`last_accessed_at` integer NOT NULL
);
