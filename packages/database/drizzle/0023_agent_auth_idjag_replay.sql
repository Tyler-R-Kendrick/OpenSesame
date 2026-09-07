CREATE TABLE "agent_provider_assertion_replays" (
	"issuer" text NOT NULL,
	"jti" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "agent_provider_assertion_replays_pk" PRIMARY KEY("issuer","jti")
);
--> statement-breakpoint
CREATE INDEX "agent_provider_assertion_replays_expires_idx" ON "agent_provider_assertion_replays" USING btree ("expires_at");
