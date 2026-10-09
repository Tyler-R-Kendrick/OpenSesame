ALTER TABLE "interaction_proof_attempts" DROP CONSTRAINT "interaction_proof_attempts_mechanism_check";
--> statement-breakpoint
ALTER TABLE "interaction_proof_attempts" ADD CONSTRAINT "interaction_proof_attempts_mechanism_check" CHECK ("interaction_proof_attempts"."mechanism" in ('webauthn','openid4vp','session_reauth','out_of_band'));
