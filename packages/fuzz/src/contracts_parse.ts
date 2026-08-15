import { CreateClaimRequestSchema } from "@opensesame/contracts";
import { FuzzedDataProvider } from "./provider.js";

export function fuzz(data: Buffer): void {
  const p = new FuzzedDataProvider(data);
  const raw = p.consumeRemainingAsString();
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return;
  }
  const result = CreateClaimRequestSchema.safeParse(parsed);
  if (result.success) {
    if (
      result.data.ttlSeconds !== undefined &&
      result.data.ttlSeconds > 86_400
    ) {
      throw new Error("ttl exceeded schema max");
    }
  }
}
