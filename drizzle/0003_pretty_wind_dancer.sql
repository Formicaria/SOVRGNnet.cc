CREATE TABLE "serverBans" (
	"id" serial PRIMARY KEY NOT NULL,
	"serverId" integer NOT NULL,
	"userId" integer NOT NULL,
	"bannedBy" integer NOT NULL,
	"reason" text,
	"createdAt" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "editedAt" timestamp;