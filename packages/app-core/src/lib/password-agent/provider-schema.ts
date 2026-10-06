import { z } from "zod";
export const jsonValueSchema = z.json();
export type JsonValue = z.infer<typeof jsonValueSchema>;
export const recordSchema = z.record(z.string(), jsonValueSchema);
export type RecordValue = z.infer<typeof recordSchema>;
export const fieldSchema = z.object({
  id: z.string(),
  label: z.string().optional(),
  type: z.string(),
  purpose: z.string().optional(),
  reference: z.string().optional(),
  section: z.object({ label: z.string().optional() }).optional(),
});
export const discoveryItemSchema = z.object({
  id: z.string(),
  title: z.string(),
  category: z.string(),
  vault: z.object({ name: z.string() }),
  tags: z.array(z.string()).optional(),
  urls: z.array(z.object({ href: z.string() })).optional(),
  created_at: z.string().optional(),
  updated_at: z.string().optional(),
  fields: z.array(fieldSchema),
});
export type DiscoveryItem = z.infer<typeof discoveryItemSchema>;
export type DiscoveryField = z.infer<typeof fieldSchema>;
export const optionalStringSchema = z.string().optional();
