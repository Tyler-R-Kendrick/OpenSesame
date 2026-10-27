import { z } from "zod";

export const ProviderCategorySchema = z.enum([
  "identity",
  "backup_recovery",
  "encryption",
  "password_managers",
  "agent_harnesses",
  "cua_runtime",
  "ai_model_provider",
  "networking",
  "wallet",
  "cloud_secret_storage",
  "local_storage",
  "developer",
  "productivity",
  "communication",
  "storage",
  "crm",
  "testing",
  "certificates",
  "custom",
]);
export type ProviderCategory = z.infer<typeof ProviderCategorySchema>;
