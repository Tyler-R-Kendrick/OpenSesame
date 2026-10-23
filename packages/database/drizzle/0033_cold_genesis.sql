-- Keep the oldest row for each email and rename later duplicates so the
-- unique index can be created without deleting accounts or their sessions.
WITH ranked AS (
  SELECT id, email,
         row_number() OVER (PARTITION BY email ORDER BY created_at, id) AS rn
  FROM better_auth_users
)
UPDATE better_auth_users u
SET email = u.email || '+duplicate-' || u.id
FROM ranked r
WHERE u.id = r.id AND r.rn > 1;
--> statement-breakpoint
CREATE UNIQUE INDEX "better_auth_users_email_uidx" ON "better_auth_users" USING btree ("email");