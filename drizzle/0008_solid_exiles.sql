ALTER TABLE "messages" ALTER COLUMN "userId" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "senderMatrixId" varchar(255);