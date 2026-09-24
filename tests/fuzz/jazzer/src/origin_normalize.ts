import {
  canonicalResource,
  isResourceAllowed,
} from "@opensesame/oauth-provider";
import { FuzzedDataProvider } from "./provider.js";

export function fuzz(data: Buffer): void {
  const p = new FuzzedDataProvider(data);
  const raw = p.consumeString(64);
  const issuer = p.consumeString(64) || "https://idp.example";
  const a = canonicalResource(raw);
  const b = canonicalResource(raw);
  if (a !== b) {
    throw new Error("canonicalResource is not deterministic");
  }
  if (a?.includes("#") || a?.includes("?")) {
    throw new Error("canonical resource must drop query/fragment");
  }
  if (
    !isResourceAllowed(raw, [], issuer) &&
    a &&
    a === canonicalResource(issuer)
  ) {
    throw new Error("issuer self-audience was denied");
  }
}
