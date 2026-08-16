DROP TABLE "nitroSubscriptions" CASCADE;--> statement-breakpoint
ALTER TABLE "soundboardClips" DROP COLUMN "isNitroOnly";--> statement-breakpoint
DROP TYPE "public"."nitro_tier";