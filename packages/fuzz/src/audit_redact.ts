import { redactAuditMetadata } from "@opensesame/audit";
import { type JsonObject, overlapCast } from "@opensesame/os-domain";
import { assertNoSecretFields } from "./oracles.js";
import { FuzzedDataProvider } from "./provider.js";

export function fuzz(data: Buffer): void {
  const p = new FuzzedDataProvider(data);
  const meta: JsonObject = {
    action: p.consumeString(16),
    access_token: "SUPERSECRET",
    password: "SUPERSECRET",
    reason: p.consumeString(16),
  };
  assertNoSecretFields(meta, (v) => redactAuditMetadata(overlapCast(v)));
}
