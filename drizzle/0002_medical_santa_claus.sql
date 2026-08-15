ALTER TABLE "servers" ADD COLUMN "inviteCode" varchar(32);--> statement-breakpoint
ALTER TABLE "servers" ADD CONSTRAINT "servers_inviteCode_unique" UNIQUE("inviteCode");