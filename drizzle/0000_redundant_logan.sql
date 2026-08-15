CREATE TYPE "public"."channel_type" AS ENUM('text', 'voice', 'video');--> statement-breakpoint
CREATE TYPE "public"."nitro_tier" AS ENUM('basic', 'pro', 'ultra');--> statement-breakpoint
CREATE TYPE "public"."role" AS ENUM('user', 'admin');--> statement-breakpoint
CREATE TYPE "public"."server_member_role" AS ENUM('owner', 'admin', 'moderator', 'member');--> statement-breakpoint
CREATE TABLE "channels" (
	"id" serial PRIMARY KEY NOT NULL,
	"serverId" integer NOT NULL,
	"name" varchar(255) NOT NULL,
	"description" text,
	"matrixRoomId" varchar(255) NOT NULL,
	"type" "channel_type" DEFAULT 'text' NOT NULL,
	"isPrivate" boolean DEFAULT false NOT NULL,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	"updatedAt" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "channels_matrixRoomId_unique" UNIQUE("matrixRoomId")
);
--> statement-breakpoint
CREATE TABLE "fileShares" (
	"id" serial PRIMARY KEY NOT NULL,
	"channelId" integer NOT NULL,
	"userId" integer NOT NULL,
	"filename" varchar(255) NOT NULL,
	"ipfsHash" varchar(255) NOT NULL,
	"fileSize" bigint NOT NULL,
	"mimeType" varchar(100),
	"torrentMagnetLink" text,
	"createdAt" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "messages" (
	"id" serial PRIMARY KEY NOT NULL,
	"channelId" integer NOT NULL,
	"userId" integer NOT NULL,
	"content" text NOT NULL,
	"matrixEventId" varchar(255) NOT NULL,
	"encrypted" boolean DEFAULT true NOT NULL,
	"reactions" json,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	"updatedAt" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "messages_matrixEventId_unique" UNIQUE("matrixEventId")
);
--> statement-breakpoint
CREATE TABLE "nitroSubscriptions" (
	"id" serial PRIMARY KEY NOT NULL,
	"userId" integer NOT NULL,
	"walletAddress" varchar(255) NOT NULL,
	"nftContractAddress" varchar(255) NOT NULL,
	"nftTokenId" varchar(255) NOT NULL,
	"expiresAt" timestamp,
	"tier" "nitro_tier" DEFAULT 'basic' NOT NULL,
	"isActive" boolean DEFAULT true NOT NULL,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	"updatedAt" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "serverMembers" (
	"id" serial PRIMARY KEY NOT NULL,
	"serverId" integer NOT NULL,
	"userId" integer NOT NULL,
	"role" "server_member_role" DEFAULT 'member' NOT NULL,
	"joinedAt" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "servers" (
	"id" serial PRIMARY KEY NOT NULL,
	"name" varchar(255) NOT NULL,
	"description" text,
	"matrixRoomId" varchar(255) NOT NULL,
	"ownerId" integer NOT NULL,
	"icon" text,
	"isPublic" boolean DEFAULT true NOT NULL,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	"updatedAt" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "servers_matrixRoomId_unique" UNIQUE("matrixRoomId")
);
--> statement-breakpoint
CREATE TABLE "soundboardClips" (
	"id" serial PRIMARY KEY NOT NULL,
	"serverId" integer NOT NULL,
	"name" varchar(255) NOT NULL,
	"ipfsHash" varchar(255) NOT NULL,
	"duration" integer NOT NULL,
	"uploadedBy" integer NOT NULL,
	"isNitroOnly" boolean DEFAULT false NOT NULL,
	"createdAt" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "userProfiles" (
	"id" serial PRIMARY KEY NOT NULL,
	"userId" integer NOT NULL,
	"walletAddress" varchar(255),
	"ensName" varchar(255),
	"avatar" text,
	"bio" text,
	"matrixUserId" varchar(255),
	"createdAt" timestamp DEFAULT now() NOT NULL,
	"updatedAt" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "userProfiles_walletAddress_unique" UNIQUE("walletAddress"),
	CONSTRAINT "userProfiles_matrixUserId_unique" UNIQUE("matrixUserId")
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" serial PRIMARY KEY NOT NULL,
	"openId" varchar(64) NOT NULL,
	"name" text,
	"email" varchar(320),
	"passwordHash" text,
	"loginMethod" varchar(64),
	"role" "role" DEFAULT 'user' NOT NULL,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	"updatedAt" timestamp DEFAULT now() NOT NULL,
	"lastSignedIn" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "users_openId_unique" UNIQUE("openId"),
	CONSTRAINT "users_email_unique" UNIQUE("email")
);
