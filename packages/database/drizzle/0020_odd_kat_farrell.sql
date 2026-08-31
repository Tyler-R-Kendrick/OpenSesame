CREATE TABLE "approval_activations" (
	"id" text PRIMARY KEY NOT NULL,
	"auth_req_id" text NOT NULL,
	"principal_id" text NOT NULL,
	"transaction_digest" text NOT NULL,
	"decision" text NOT NULL,
	"policy_digest" text NOT NULL,
	"channel_kind" text NOT NULL,
	"challenge_digest" text NOT NULL,
	"state" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"activated_at" timestamp with time zone,
	"consumed_at" timestamp with time zone,
	"expires_at" timestamp with time zone NOT NULL,
	"trust_session_id" text,
	"method" text,
	"version" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "approval_activations_decision_check" CHECK ("approval_activations"."decision" in ('approved','denied')),
	CONSTRAINT "approval_activations_state_check" CHECK ("approval_activations"."state" in ('pending','activated','consumed')),
	CONSTRAINT "approval_activations_channel_kind_check" CHECK ("approval_activations"."channel_kind" in ('in_app','native_push','slack','teams','telegram','wechat','sms','webhook'))
);
--> statement-breakpoint
CREATE TABLE "approval_receipts" (
	"id" text PRIMARY KEY NOT NULL,
	"auth_req_id" text NOT NULL,
	"principal_id" text NOT NULL,
	"decision" text NOT NULL,
	"decided_by_kind" text NOT NULL,
	"path" text NOT NULL,
	"channel_kind" text NOT NULL,
	"binding_id" text,
	"request_digest" text NOT NULL,
	"transaction_digest" text NOT NULL,
	"policy_digest" text NOT NULL,
	"required_assurance" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"achieved_assurance" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"evidence_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"trust_session_id" text,
	"activation_id" text,
	"comparison_required" boolean DEFAULT false NOT NULL,
	"comparison_satisfied" boolean DEFAULT false NOT NULL,
	"callback_digest" text,
	"decided_at" timestamp with time zone DEFAULT now() NOT NULL,
	"receipt_version" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "approval_receipts_decision_check" CHECK ("approval_receipts"."decision" in ('approved','denied')),
	CONSTRAINT "approval_receipts_decided_by_kind_check" CHECK ("approval_receipts"."decided_by_kind" in ('human','agent')),
	CONSTRAINT "approval_receipts_path_check" CHECK ("approval_receipts"."path" in ('in_app','external_rendezvous','external_direct','agent')),
	CONSTRAINT "approval_receipts_channel_kind_check" CHECK ("approval_receipts"."channel_kind" in ('in_app','native_push','slack','teams','telegram','wechat','sms','webhook'))
);
--> statement-breakpoint
CREATE TABLE "callback_replays" (
	"id" text PRIMARY KEY NOT NULL,
	"provider_id" text NOT NULL,
	"callback_digest" text NOT NULL,
	"seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"auth_req_id" text
);
--> statement-breakpoint
CREATE TABLE "channel_binding_challenges" (
	"id" text PRIMARY KEY NOT NULL,
	"principal_id" text NOT NULL,
	"kind" text NOT NULL,
	"provider_id" text NOT NULL,
	"nonce_digest" text NOT NULL,
	"expected_tenant_id" text,
	"expected_subject_id" text,
	"attempts" integer DEFAULT 0 NOT NULL,
	"max_attempts" integer DEFAULT 5 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"completed_at" timestamp with time zone,
	"version" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "channel_binding_challenges_kind_check" CHECK ("channel_binding_challenges"."kind" in ('in_app','native_push','slack','teams','telegram','wechat','sms','webhook'))
);
--> statement-breakpoint
CREATE TABLE "channel_bindings" (
	"id" text PRIMARY KEY NOT NULL,
	"principal_id" text NOT NULL,
	"kind" text NOT NULL,
	"provider_id" text NOT NULL,
	"provider_tenant_id" text NOT NULL,
	"provider_subject_id" text NOT NULL,
	"display_label" text,
	"state" text NOT NULL,
	"verification" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"verified_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"expires_at" timestamp with time zone,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "channel_bindings_kind_check" CHECK ("channel_bindings"."kind" in ('in_app','native_push','slack','teams','telegram','wechat','sms','webhook')),
	CONSTRAINT "channel_bindings_state_check" CHECK ("channel_bindings"."state" in ('pending','active','revoked','expired')),
	CONSTRAINT "channel_bindings_verification_check" CHECK ("channel_bindings"."verification" in ('provider_oauth_install','provider_callback_challenge','push_subscription','operator_provisioned')),
	CONSTRAINT "channel_bindings_provider_subject_id_check" CHECK ("channel_bindings"."provider_subject_id" <> '')
);
--> statement-breakpoint
CREATE TABLE "comparison_challenges" (
	"id" text PRIMARY KEY NOT NULL,
	"auth_req_id" text NOT NULL,
	"value_digest" text NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"max_attempts" integer DEFAULT 5 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"satisfied_at" timestamp with time zone,
	"version" integer DEFAULT 1 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "notification_deliveries" (
	"id" text PRIMARY KEY NOT NULL,
	"principal_id" text NOT NULL,
	"kind" text NOT NULL,
	"binding_id" text,
	"endpoint_id" text,
	"destination_id" text GENERATED ALWAYS AS (coalesce("binding_id", "endpoint_id", '')) STORED NOT NULL,
	"notification_class" text NOT NULL,
	"event_type" text NOT NULL,
	"outbox_event_id" text NOT NULL,
	"auth_req_id" text,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"confidentiality" text NOT NULL,
	"state" text NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"delivered_at" timestamp with time zone,
	"provider_message_ref" text,
	CONSTRAINT "notification_deliveries_kind_check" CHECK ("notification_deliveries"."kind" in ('in_app','native_push','slack','teams','telegram','wechat','sms','webhook')),
	CONSTRAINT "notification_deliveries_confidentiality_check" CHECK ("notification_deliveries"."confidentiality" in ('minimal','descriptive','full')),
	CONSTRAINT "notification_deliveries_state_check" CHECK ("notification_deliveries"."state" in ('pending','delivered','failed','dead','skipped'))
);
--> statement-breakpoint
CREATE TABLE "notification_preferences" (
	"principal_id" text PRIMARY KEY NOT NULL,
	"by_class" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"version" integer DEFAULT 1 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "push_subscriptions" (
	"id" text PRIMARY KEY NOT NULL,
	"principal_id" text NOT NULL,
	"endpoint" text NOT NULL,
	"p256dh_key" text NOT NULL,
	"auth_secret" text NOT NULL,
	"endpoint_digest" text NOT NULL,
	"device_label" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_used_at" timestamp with time zone,
	"disabled_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "approval_activations" ADD CONSTRAINT "approval_activations_principal_id_principals_id_fk" FOREIGN KEY ("principal_id") REFERENCES "public"."principals"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "channel_binding_challenges" ADD CONSTRAINT "channel_binding_challenges_principal_id_principals_id_fk" FOREIGN KEY ("principal_id") REFERENCES "public"."principals"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "channel_bindings" ADD CONSTRAINT "channel_bindings_principal_id_principals_id_fk" FOREIGN KEY ("principal_id") REFERENCES "public"."principals"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification_deliveries" ADD CONSTRAINT "notification_deliveries_principal_id_principals_id_fk" FOREIGN KEY ("principal_id") REFERENCES "public"."principals"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification_preferences" ADD CONSTRAINT "notification_preferences_principal_id_principals_id_fk" FOREIGN KEY ("principal_id") REFERENCES "public"."principals"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "push_subscriptions" ADD CONSTRAINT "push_subscriptions_principal_id_principals_id_fk" FOREIGN KEY ("principal_id") REFERENCES "public"."principals"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "approval_activations_challenge_digest_uidx" ON "approval_activations" USING btree ("challenge_digest");--> statement-breakpoint
CREATE INDEX "approval_activations_auth_req_idx" ON "approval_activations" USING btree ("auth_req_id","state");--> statement-breakpoint
CREATE INDEX "approval_activations_principal_id_idx" ON "approval_activations" USING btree ("principal_id");--> statement-breakpoint
CREATE UNIQUE INDEX "approval_receipts_auth_req_id_uidx" ON "approval_receipts" USING btree ("auth_req_id");--> statement-breakpoint
CREATE INDEX "approval_receipts_principal_id_idx" ON "approval_receipts" USING btree ("principal_id");--> statement-breakpoint
CREATE INDEX "callback_replays_expires_at_idx" ON "callback_replays" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "callback_replays_auth_req_id_idx" ON "callback_replays" USING btree ("auth_req_id");--> statement-breakpoint
CREATE INDEX "channel_binding_challenges_principal_id_idx" ON "channel_binding_challenges" USING btree ("principal_id");--> statement-breakpoint
CREATE INDEX "channel_binding_challenges_expires_at_idx" ON "channel_binding_challenges" USING btree ("expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "channel_bindings_provider_identity_uidx" ON "channel_bindings" USING btree ("kind","provider_id","provider_tenant_id","provider_subject_id");--> statement-breakpoint
CREATE INDEX "channel_bindings_principal_id_idx" ON "channel_bindings" USING btree ("principal_id");--> statement-breakpoint
CREATE UNIQUE INDEX "comparison_challenges_auth_req_id_uidx" ON "comparison_challenges" USING btree ("auth_req_id");--> statement-breakpoint
CREATE INDEX "comparison_challenges_expires_at_idx" ON "comparison_challenges" USING btree ("expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "notification_deliveries_event_kind_destination_uidx" ON "notification_deliveries" USING btree ("outbox_event_id","kind","destination_id");--> statement-breakpoint
CREATE INDEX "notification_deliveries_next_attempt_idx" ON "notification_deliveries" USING btree ("next_attempt_at");--> statement-breakpoint
CREATE INDEX "notification_deliveries_principal_id_idx" ON "notification_deliveries" USING btree ("principal_id");--> statement-breakpoint
CREATE INDEX "notification_deliveries_auth_req_id_idx" ON "notification_deliveries" USING btree ("auth_req_id");--> statement-breakpoint
CREATE UNIQUE INDEX "push_subscriptions_endpoint_digest_uidx" ON "push_subscriptions" USING btree ("endpoint_digest");--> statement-breakpoint
CREATE INDEX "push_subscriptions_principal_id_idx" ON "push_subscriptions" USING btree ("principal_id");