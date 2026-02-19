CREATE TABLE `channels` (
	`id` int AUTO_INCREMENT NOT NULL,
	`serverId` int NOT NULL,
	`name` varchar(255) NOT NULL,
	`description` text,
	`matrixRoomId` varchar(255) NOT NULL,
	`type` enum('text','voice','video') NOT NULL DEFAULT 'text',
	`isPrivate` boolean NOT NULL DEFAULT false,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `channels_id` PRIMARY KEY(`id`),
	CONSTRAINT `channels_matrixRoomId_unique` UNIQUE(`matrixRoomId`)
);
--> statement-breakpoint
CREATE TABLE `fileShares` (
	`id` int AUTO_INCREMENT NOT NULL,
	`channelId` int NOT NULL,
	`userId` int NOT NULL,
	`filename` varchar(255) NOT NULL,
	`ipfsHash` varchar(255) NOT NULL,
	`fileSize` bigint NOT NULL,
	`mimeType` varchar(100),
	`torrentMagnetLink` text,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `fileShares_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `messages` (
	`id` int AUTO_INCREMENT NOT NULL,
	`channelId` int NOT NULL,
	`userId` int NOT NULL,
	`content` text NOT NULL,
	`matrixEventId` varchar(255) NOT NULL,
	`encrypted` boolean NOT NULL DEFAULT true,
	`reactions` json,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `messages_id` PRIMARY KEY(`id`),
	CONSTRAINT `messages_matrixEventId_unique` UNIQUE(`matrixEventId`)
);
--> statement-breakpoint
CREATE TABLE `nitroSubscriptions` (
	`id` int AUTO_INCREMENT NOT NULL,
	`userId` int NOT NULL,
	`walletAddress` varchar(255) NOT NULL,
	`nftContractAddress` varchar(255) NOT NULL,
	`nftTokenId` varchar(255) NOT NULL,
	`expiresAt` timestamp,
	`tier` enum('basic','pro','ultra') NOT NULL DEFAULT 'basic',
	`isActive` boolean NOT NULL DEFAULT true,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `nitroSubscriptions_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `serverMembers` (
	`id` int AUTO_INCREMENT NOT NULL,
	`serverId` int NOT NULL,
	`userId` int NOT NULL,
	`role` enum('owner','admin','moderator','member') NOT NULL DEFAULT 'member',
	`joinedAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `serverMembers_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `servers` (
	`id` int AUTO_INCREMENT NOT NULL,
	`name` varchar(255) NOT NULL,
	`description` text,
	`matrixRoomId` varchar(255) NOT NULL,
	`ownerId` int NOT NULL,
	`icon` text,
	`isPublic` boolean NOT NULL DEFAULT true,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `servers_id` PRIMARY KEY(`id`),
	CONSTRAINT `servers_matrixRoomId_unique` UNIQUE(`matrixRoomId`)
);
--> statement-breakpoint
CREATE TABLE `soundboardClips` (
	`id` int AUTO_INCREMENT NOT NULL,
	`serverId` int NOT NULL,
	`name` varchar(255) NOT NULL,
	`ipfsHash` varchar(255) NOT NULL,
	`duration` int NOT NULL,
	`uploadedBy` int NOT NULL,
	`isNitroOnly` boolean NOT NULL DEFAULT false,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `soundboardClips_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `userProfiles` (
	`id` int AUTO_INCREMENT NOT NULL,
	`userId` int NOT NULL,
	`walletAddress` varchar(255),
	`ensName` varchar(255),
	`avatar` text,
	`bio` text,
	`matrixUserId` varchar(255),
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `userProfiles_id` PRIMARY KEY(`id`),
	CONSTRAINT `userProfiles_walletAddress_unique` UNIQUE(`walletAddress`),
	CONSTRAINT `userProfiles_matrixUserId_unique` UNIQUE(`matrixUserId`)
);
