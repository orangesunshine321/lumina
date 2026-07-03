CREATE TABLE `photo_sets` (
	`id` text PRIMARY KEY NOT NULL,
	`gallery_id` text NOT NULL,
	`title` text NOT NULL,
	`sort_index` integer DEFAULT 0 NOT NULL,
	`visible_to_client` integer DEFAULT true NOT NULL,
	`allow_downloads` integer DEFAULT false NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`gallery_id`) REFERENCES `galleries`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `photo_sets_gallery_id_idx` ON `photo_sets` (`gallery_id`);--> statement-breakpoint
CREATE INDEX `photo_sets_gallery_sort_idx` ON `photo_sets` (`gallery_id`,`sort_index`);--> statement-breakpoint
ALTER TABLE `photos` ADD `set_id` text REFERENCES photo_sets(id) ON DELETE SET NULL;--> statement-breakpoint
CREATE INDEX `photos_set_idx` ON `photos` (`set_id`);