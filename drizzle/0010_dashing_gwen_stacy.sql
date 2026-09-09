ALTER TABLE "instanceSettings" ADD COLUMN "federationEnabled" boolean;--> statement-breakpoint
ALTER TABLE "instanceSettings" ADD COLUMN "matrixPublicUrl" varchar(500);--> statement-breakpoint
ALTER TABLE "instanceSettings" ADD COLUMN "ssoEnabled" boolean;--> statement-breakpoint
ALTER TABLE "instanceSettings" ADD COLUMN "identityIssuer" varchar(500);--> statement-breakpoint
ALTER TABLE "instanceSettings" ADD COLUMN "voiceUrl" varchar(500);--> statement-breakpoint
ALTER TABLE "instanceSettings" ADD COLUMN "voiceApiKey" varchar(200);--> statement-breakpoint
ALTER TABLE "instanceSettings" ADD COLUMN "voiceApiSecret" text;--> statement-breakpoint
ALTER TABLE "instanceSettings" ADD COLUMN "ipfsApiUrl" varchar(500);--> statement-breakpoint
ALTER TABLE "instanceSettings" ADD COLUMN "metricsToken" text;--> statement-breakpoint
ALTER TABLE "instanceSettings" ADD COLUMN "readyTimeoutMs" integer;