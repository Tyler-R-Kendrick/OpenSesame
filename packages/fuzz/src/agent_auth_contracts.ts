import { AgentIdentityRequestSchema } from "@opensesame/contracts";
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
  const result = AgentIdentityRequestSchema.safeParse(parsed);
  if (!result.success) return;
  if (result.data.type === "anonymous") {
    if ("login_hint" in result.data || "assertion" in result.data) {
      throw new Error("anonymous body carried another type's fields");
    }
  }
  if (
    result.data.type === "service_auth" &&
    result.data.login_hint.length === 0
  ) {
    throw new Error("empty login_hint accepted");
  }
}
