-- Pairwise sector keys become a stored, owned column (security finding: legacy
-- non-canonical sector spellings shared a pairwise `sub`).
--
-- The pairwise `sub` is keyed on `pairwiseSectorKey(sector_identifier)`
-- (packages/oauth-provider/src/pairwise/sector.ts): host lowercased, default
-- port dropped, a bare `/` path dropped. Registrations stored before that key
-- existed kept whatever spelling they were sent with, and the cross-owner check
-- compared spellings exactly, so `https://rp.example` (owner A) and
-- `https://RP.example:443/` (owner B) now meet on one key and one `sub`.
--
-- This migration:
--   1. adds `sector_key` and backfills it with the same derivation, in SQL. Only
--      a spelling the SQL can prove it derives exactly as the WHATWG URL parser
--      does is keyed: plain ASCII host, optional numeric port, a path of plain
--      characters with no dot segments, no percent-escapes, no IPv4 shorthand
--      and no IDNA labels. Anything else (none of which the registration API
--      has ever produced from an ordinary https URL) is keyed `unparsed:<raw>`,
--      which no real key can equal, and blocked as `unparsed_legacy_spelling`:
--      a guess that differed from the issuer's own derivation could land two
--      owners on one `sub`, so the row is refused instead of guessed at.
--   2. creates `oauth_client_sector_claims`, one holder per key, and gives each
--      key to the owner of its earliest live client (earliest client of any
--      state when every one of them is revoked).
--   3. fails safe on pre-existing cross-owner collisions: every client on a key
--      whose owner is not that key's holder is blocked as
--      `cross_owner_collision`. The pairwise callback refuses a blocked client
--      (invalid_client, "re-register ..."), so no `sub` is issued to it again;
--      its owner re-registers under a sector of their own. The holder's clients
--      keep the key and the subjects they already had.
--
-- The interaction_proof_attempts mechanism check drift drizzle-kit also emitted
-- here was already applied by 0026 and is deliberately left out.
CREATE TABLE "oauth_client_sector_claims" (
	"sector_key" text PRIMARY KEY NOT NULL,
	"owner_key" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "oauth_clients" ADD COLUMN "sector_key" text;--> statement-breakpoint
ALTER TABLE "oauth_clients" ADD COLUMN "sector_key_blocked" text;--> statement-breakpoint
WITH "trimmed" AS (
	SELECT "id", btrim("sector_identifier", E' \t\n\r\f\v') AS "raw"
	FROM "oauth_clients"
), "parsed" AS (
	SELECT "id", "raw",
		"raw" ~* '^https?:' AS "urlish",
		regexp_match(
			"raw",
			'^(https?)://([A-Za-z0-9_.-]+)(?::([0-9]{0,5}))?(/[A-Za-z0-9._~!$&''()*+,;=:@/-]*)?$',
			'i'
		) AS "m"
	FROM "trimmed"
), "exact" AS (
	SELECT "id", "raw", "urlish", "m",
		lower("m"[1]) AS "scheme",
		lower("m"[2]) AS "host",
		nullif("m"[3], '')::integer AS "port",
		coalesce("m"[4], '') AS "path",
		"raw" ~ '[^\x21-\x7e]'
			OR ("urlish" AND (
				"m" IS NULL
				OR lower("m"[2]) ~ '(^|\.)xn--'
				OR (
					lower("m"[2]) ~ '(^|\.)([0-9]+|0x[0-9a-f]*)\.?$'
					AND lower("m"[2]) !~ '^(25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9]?[0-9])(\.(25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9]?[0-9])){3}$'
				)
				OR coalesce("m"[4], '') ~ '(^|/)\.\.?(/|$)'
				OR coalesce(nullif("m"[3], ''), '0')::integer > 65535
			)) AS "unparsed"
	FROM "parsed"
)
UPDATE "oauth_clients" AS "c"
SET
	"sector_key" = CASE
		WHEN "e"."unparsed" THEN 'unparsed:' || "e"."raw"
		WHEN NOT "e"."urlish" THEN "e"."raw"
		ELSE "e"."host"
			|| CASE
				WHEN "e"."port" IS NULL THEN ''
				WHEN "e"."scheme" = 'https' AND "e"."port" = 443 THEN ''
				WHEN "e"."scheme" = 'http' AND "e"."port" = 80 THEN ''
				ELSE ':' || "e"."port"::text
			END
			|| CASE WHEN "e"."path" IN ('', '/') THEN '' ELSE "e"."path" END
	END,
	"sector_key_blocked" = CASE WHEN "e"."unparsed" THEN 'unparsed_legacy_spelling' END
FROM "exact" AS "e"
WHERE "c"."id" = "e"."id";--> statement-breakpoint
ALTER TABLE "oauth_clients" ALTER COLUMN "sector_key" SET NOT NULL;--> statement-breakpoint
INSERT INTO "oauth_client_sector_claims" ("sector_key", "owner_key")
SELECT DISTINCT ON ("sector_key")
	"sector_key", coalesce("owner_principal_id", 'client:' || "id")
FROM "oauth_clients"
WHERE "sector_key_blocked" IS NULL
ORDER BY "sector_key", ("state" = 'revoked'), "created_at", "id";--> statement-breakpoint
UPDATE "oauth_clients" AS "c"
SET "sector_key_blocked" = 'cross_owner_collision'
FROM "oauth_client_sector_claims" AS "k"
WHERE "c"."sector_key" = "k"."sector_key"
	AND "c"."sector_key_blocked" IS NULL
	AND coalesce("c"."owner_principal_id", 'client:' || "c"."id") <> "k"."owner_key";--> statement-breakpoint
CREATE INDEX "oauth_clients_sector_key_idx" ON "oauth_clients" USING btree ("sector_key");--> statement-breakpoint
ALTER TABLE "oauth_clients" ADD CONSTRAINT "oauth_clients_sector_key_blocked_check" CHECK ("oauth_clients"."sector_key_blocked" in ('cross_owner_collision','unparsed_legacy_spelling'));
