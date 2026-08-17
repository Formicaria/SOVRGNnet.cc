-- Username becomes the account's identity.
--
-- Deliberately no backfill. There is no username that can be invented for an
-- existing account that is both correct and permanent: a generated one
-- (`user_7`, or the local part of an email) becomes that person's Matrix
-- localpart forever, because Matrix has no rename — see docs/adr for what a
-- new MXID actually costs. Guessing on someone's behalf and making the guess
-- permanent is worse than refusing.
--
-- So this migration only runs on an instance with no accounts yet. Every
-- deployment that exists today is a test instance, which is what makes that
-- acceptable; if that stops being true, the replacement is an interactive
-- claim flow, not a backfill added here later.
--
-- The guard exists because without it Postgres raises
--   column "username" of relation "users" contains null values
-- which is true, unhelpful, and gives an operator nothing to do about it.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM "users") THEN
    RAISE EXCEPTION
      'Cannot add usernames to an instance that already has accounts.'
      USING
        DETAIL =
          'Usernames became required in 0009, and this migration will not '
          'invent one for an existing account: it would become that account''s '
          'permanent Matrix ID, which cannot be changed afterwards.',
        HINT =
          'This is alpha software and every account here is a test account. '
          'Reset the database and register again. To keep the data instead, '
          'stop at 0008 and wait for the claim flow.';
  END IF;
END
$$;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "username" varchar(32) NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "usernameFold" varchar(32) NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_username_unique" UNIQUE("username");--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_usernameFold_unique" UNIQUE("usernameFold");
