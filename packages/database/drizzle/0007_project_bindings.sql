ALTER TABLE "projects" ADD COLUMN "sealed_store_tomb_name" text;--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "pages_vault_folder_id" text;--> statement-breakpoint
CREATE UNIQUE INDEX "projects_owner_personal_slug_uidx" ON "projects" USING btree ("owner_principal_id","slug") WHERE "slug" = 'personal' and "owner_principal_id" is not null;
