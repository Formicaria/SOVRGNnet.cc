CREATE TABLE "accounts" (
	"id" serial PRIMARY KEY NOT NULL,
	"subject" varchar(64) NOT NULL,
	"email" varchar(320) NOT NULL,
	"emailVerified" boolean DEFAULT false NOT NULL,
	"passwordHash" text,
	"displayName" varchar(80),
	"avatar" text,
	"suspendedAt" timestamp,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	"updatedAt" timestamp DEFAULT now() NOT NULL,
	"lastSignedIn" timestamp,
	CONSTRAINT "accounts_subject_unique" UNIQUE("subject"),
	CONSTRAINT "accounts_email_unique" UNIQUE("email")
);
--> statement-breakpoint
CREATE TABLE "deviceAuthorizations" (
	"id" serial PRIMARY KEY NOT NULL,
	"deviceCodeHash" varchar(64) NOT NULL,
	"userCode" varchar(16) NOT NULL,
	"accountId" integer,
	"status" varchar(16) DEFAULT 'pending' NOT NULL,
	"sessionTokenHash" varchar(64),
	"polls" integer DEFAULT 0 NOT NULL,
	"expiresAt" timestamp NOT NULL,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	"lastPolledAt" timestamp,
	CONSTRAINT "deviceAuthorizations_deviceCodeHash_unique" UNIQUE("deviceCodeHash"),
	CONSTRAINT "deviceAuthorizations_userCode_unique" UNIQUE("userCode")
);
--> statement-breakpoint
CREATE TABLE "emailTokens" (
	"id" serial PRIMARY KEY NOT NULL,
	"accountId" integer NOT NULL,
	"purpose" varchar(16) NOT NULL,
	"tokenHash" varchar(64) NOT NULL,
	"expiresAt" timestamp NOT NULL,
	"usedAt" timestamp,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "emailTokens_tokenHash_unique" UNIQUE("tokenHash")
);
--> statement-breakpoint
CREATE TABLE "grants" (
	"id" serial PRIMARY KEY NOT NULL,
	"accountId" integer NOT NULL,
	"instanceId" varchar(64) NOT NULL,
	"instanceName" varchar(120),
	"firstUsedAt" timestamp DEFAULT now() NOT NULL,
	"lastUsedAt" timestamp DEFAULT now() NOT NULL,
	"revokedAt" timestamp
);
--> statement-breakpoint
CREATE TABLE "identities" (
	"id" serial PRIMARY KEY NOT NULL,
	"accountId" integer NOT NULL,
	"provider" varchar(32) NOT NULL,
	"providerUserId" varchar(128) NOT NULL,
	"email" varchar(320),
	"emailVerified" boolean DEFAULT false NOT NULL,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	"lastUsedAt" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "identities_provider_user" UNIQUE("provider","providerUserId")
);
--> statement-breakpoint
CREATE TABLE "oauthAttempts" (
	"id" serial PRIMARY KEY NOT NULL,
	"state" varchar(64) NOT NULL,
	"provider" varchar(32) NOT NULL,
	"codeVerifier" varchar(128),
	"returnUrl" text,
	"linkToAccountId" integer,
	"expiresAt" timestamp NOT NULL,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "oauthAttempts_state_unique" UNIQUE("state")
);
--> statement-breakpoint
CREATE TABLE "recoveryCodes" (
	"id" serial PRIMARY KEY NOT NULL,
	"accountId" integer NOT NULL,
	"codeHash" varchar(64) NOT NULL,
	"usedAt" timestamp,
	"createdAt" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sessions" (
	"id" serial PRIMARY KEY NOT NULL,
	"accountId" integer NOT NULL,
	"tokenHash" varchar(64) NOT NULL,
	"userAgent" text,
	"expiresAt" timestamp NOT NULL,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	"lastUsedAt" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "sessions_tokenHash_unique" UNIQUE("tokenHash")
);
