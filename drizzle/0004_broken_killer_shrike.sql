CREATE TABLE "instanceSettings" (
	"id" integer PRIMARY KEY DEFAULT 1 NOT NULL,
	"name" varchar(120),
	"description" text,
	"joinPolicy" varchar(16) DEFAULT 'invite' NOT NULL,
	"listed" boolean DEFAULT false NOT NULL,
	"updatedAt" timestamp DEFAULT now() NOT NULL
);
