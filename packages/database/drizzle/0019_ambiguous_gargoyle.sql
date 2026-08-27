ALTER TABLE "authentication_applications" ADD COLUMN "api_keys" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "authentication_applications" ADD COLUMN "configurations" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "authentication_applications" ADD COLUMN "manual_tokens_enabled" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "authentication_applications" ADD COLUMN "magic_links_enabled" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "authentication_challenges" ADD COLUMN "authentication_purpose" text;--> statement-breakpoint
ALTER TABLE "authentication_challenges" ADD COLUMN "require_user_verification" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "authentication_registration_tokens" ADD COLUMN "alias_hashing" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "authentication_registration_tokens" ADD COLUMN "authenticator_attachment" text;--> statement-breakpoint
ALTER TABLE "authentication_registration_tokens" ADD COLUMN "user_verification" text DEFAULT 'required' NOT NULL;--> statement-breakpoint
ALTER TABLE "authentication_signin_tokens" ADD COLUMN "purpose" text DEFAULT 'sign-in' NOT NULL;--> statement-breakpoint
ALTER TABLE "authentication_signin_tokens" ADD COLUMN "type" text DEFAULT 'passkey' NOT NULL;
--> statement-breakpoint
UPDATE "authentication_applications"
SET "api_keys" = jsonb_build_array(jsonb_build_object(
  'id', 'authkey_legacy',
  'secretHash', "secret_hash",
  'secretPrefix', "secret_prefix",
  'state', 'active',
  'createdAt', "created_at"
));
--> statement-breakpoint
UPDATE "authentication_applications"
SET "configurations" = '[{"purpose":"sign-in","timeToLiveSeconds":120,"userVerification":"preferred","hints":[]},{"purpose":"step-up","timeToLiveSeconds":180,"userVerification":"required","hints":[]}]'::jsonb;
