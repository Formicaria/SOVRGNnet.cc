ALTER TABLE "serverMembers" ADD COLUMN "nickname" varchar(80);--> statement-breakpoint
ALTER TABLE "serverMembers" ADD COLUMN "avatar" text;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "ssoSubject" varchar(128);--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_ssoSubject_unique" UNIQUE("ssoSubject");