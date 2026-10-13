ALTER TABLE "offers" ADD COLUMN "declined_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "offers" ADD COLUMN "expired_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "offers" ADD COLUMN "withdrawn_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "shift_slots" ADD COLUMN "gap_reason" text;--> statement-breakpoint
ALTER TABLE "shift_slots" ADD COLUMN "search_radius_mi" integer;--> statement-breakpoint
ALTER TABLE "shift_slots" ADD COLUMN "cancelled_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "shift_slots" ADD COLUMN "cancelled_by" text;--> statement-breakpoint
ALTER TABLE "venues" ADD COLUMN "address" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "venues" ADD COLUMN "search_radius_mi" integer DEFAULT 10 NOT NULL;--> statement-breakpoint
ALTER TABLE "shift_slots" ADD CONSTRAINT "slots_radius_ck" CHECK ("shift_slots"."search_radius_mi" is null or "shift_slots"."search_radius_mi" between 1 and 100);--> statement-breakpoint
ALTER TABLE "venues" ADD CONSTRAINT "venues_search_radius_ck" CHECK ("venues"."search_radius_mi" between 1 and 100);