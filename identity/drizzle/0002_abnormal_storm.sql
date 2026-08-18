CREATE TABLE "hubHandoffs" (
	"id" serial PRIMARY KEY NOT NULL,
	"codeHash" varchar(64) NOT NULL,
	"accountId" integer NOT NULL,
	"expiresAt" timestamp NOT NULL,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "hubHandoffs_codeHash_unique" UNIQUE("codeHash")
);
