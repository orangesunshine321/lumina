ALTER TABLE `admin_users` ADD `totp_secret` text;--> statement-breakpoint
ALTER TABLE `admin_users` ADD `totp_enabled_at` integer;--> statement-breakpoint
ALTER TABLE `admin_users` ADD `totp_backup_codes` text;