/** Authenticated exact physical-ciphertext retirement DATA. A receipt never grants owner, root, Fresh or a held lock. */
import { z } from "zod";
import { ORIGIN_FILE_PREFIX } from "../storage-ownership.js";
const record = z.strictObject({
  scope: z.enum(["vault", "origin"]),
  path: z.string().min(1).max(1024),
  digest: z.string().regex(/^[a-f0-9]{64}$/u),
});
export const nodePhysicalRetirementSchema = z.strictObject({
  version: z.literal(1),
  phase: z.enum(["pending", "complete"]),
  records: z.array(record).max(642),
});
export type NodePhysicalRetirement = z.infer<
  typeof nodePhysicalRetirementSchema
>;
export type NodeRetiredPhysicalRecord = z.infer<typeof record>;
export function copyNodePhysicalRetirement(
  value: NodePhysicalRetirement,
): NodePhysicalRetirement {
  const data = nodePhysicalRetirementSchema.parse(value);
  const used = new Set<string>();
  let previous = "";
  for (const item of data.records) {
    const parts = item.path.split("/");
    if (
      parts.length > 9 ||
      parts.some(
        (part) =>
          !/^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(part) ||
          part === "." ||
          part === "..",
      ) ||
      !item.path.endsWith(".json")
    )
      throw new Error("Original retirement path unavailable.");
    if (item.scope === "vault" && item.path === "opensesame-generation.v1.json")
      throw new Error("Current selected generation cannot be retired.");
    if (
      item.scope === "origin" &&
      (parts.length !== 1 || !item.path.startsWith(ORIGIN_FILE_PREFIX))
    )
      throw new Error("Original retirement scope unavailable.");
    const name = `${item.scope}/${item.path}`;
    if (used.has(name) || name <= previous)
      throw new Error("Original retirement inventory ambiguous.");
    used.add(name);
    previous = name;
    Object.freeze(item);
  }
  Object.freeze(data.records);
  return Object.freeze(data);
}
