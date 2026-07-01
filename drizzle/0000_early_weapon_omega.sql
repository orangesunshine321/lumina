CREATE TABLE `admin_sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`admin_id` text NOT NULL,
	`user_agent` text,
	`expires_at` integer NOT NULL,
	`created_at` integer NOT NULL,
	`last_seen_at` integer NOT NULL,
	FOREIGN KEY (`admin_id`) REFERENCES `admin_users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `admin_sessions_admin_id_idx` ON `admin_sessions` (`admin_id`);--> statement-breakpoint
CREATE TABLE `admin_users` (
	`id` text PRIMARY KEY NOT NULL,
	`email` text NOT NULL,
	`password_hash` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `admin_users_email_unique` ON `admin_users` (`email`);--> statement-breakpoint
CREATE TABLE `auth_attempts` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`scope` text NOT NULL,
	`gallery_id` text,
	`ip_hash` text NOT NULL,
	`success` integer NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `auth_attempts_scope_ip_idx` ON `auth_attempts` (`scope`,`ip_hash`,`created_at`);--> statement-breakpoint
CREATE INDEX `auth_attempts_scope_gallery_idx` ON `auth_attempts` (`scope`,`gallery_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `favorites` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`gallery_id` text NOT NULL,
	`photo_id` text NOT NULL,
	`toggled_by_client_token` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`gallery_id`) REFERENCES `galleries`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`photo_id`) REFERENCES `photos`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `favorites_gallery_photo_idx` ON `favorites` (`gallery_id`,`photo_id`);--> statement-breakpoint
CREATE INDEX `favorites_gallery_id_idx` ON `favorites` (`gallery_id`);--> statement-breakpoint
CREATE TABLE `galleries` (
	`id` text PRIMARY KEY NOT NULL,
	`slug` text NOT NULL,
	`title` text NOT NULL,
	`password_hash` text,
	`password_version` integer DEFAULT 0 NOT NULL,
	`cover_photo_id` text,
	`photo_count` integer DEFAULT 0 NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`cover_photo_id`) REFERENCES `photos`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `galleries_slug_idx` ON `galleries` (`slug`);--> statement-breakpoint
CREATE TABLE `photos` (
	`id` text PRIMARY KEY NOT NULL,
	`gallery_id` text NOT NULL,
	`original_filename` text NOT NULL,
	`base_filename` text NOT NULL,
	`file_ext` text NOT NULL,
	`byte_size` integer NOT NULL,
	`width` integer,
	`height` integer,
	`checksum_sha256` text NOT NULL,
	`thumbhash` text,
	`captured_at` integer,
	`sort_index` integer DEFAULT 0 NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`last_error` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`gallery_id`) REFERENCES `galleries`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `photos_gallery_id_idx` ON `photos` (`gallery_id`);--> statement-breakpoint
CREATE INDEX `photos_gallery_status_idx` ON `photos` (`gallery_id`,`status`);--> statement-breakpoint
CREATE INDEX `photos_gallery_sort_idx` ON `photos` (`gallery_id`,`sort_index`);--> statement-breakpoint
CREATE UNIQUE INDEX `photos_gallery_checksum_idx` ON `photos` (`gallery_id`,`checksum_sha256`);