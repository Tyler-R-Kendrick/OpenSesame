ALTER TABLE "projects" ADD COLUMN IF NOT EXISTS "sealed_store_tomb_name" text;--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN IF NOT EXISTS "pages_vault_folder_id" text;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "projects_owner_personal_slug_uidx" ON "projects" USING btree ("owner_principal_id","slug") WHERE "projects"."slug" = 'personal' and "projects"."owner_principal_id" is not null;
