/** Public Google consent parameters contain no token or private receiver key. */
import type { BoundaryValue } from "@opensesame/os-domain";
import { z } from "zod";
import { parseNativeImplicitState } from "./native-implicit-crypto.js";
const requestSchema = z
  .object({
    clientId: z.string().min(1).max(512),
    scopes: z.array(z.string().min(1).max(512)).min(1).max(256),
    state: z.string().min(1).max(512),
    expiresAt: z.number().finite(),
  })
  .strict();
export type NativeGoogleRequest = z.infer<typeof requestSchema>;
export function readNativeGoogleRequest(
  fragment: string,
  now: number,
): NativeGoogleRequest {
  if (fragment.length > 140_000)
    throw new Error("Invalid Google consent request");
  const params = new URLSearchParams(fragment.replace(/^#/, ""));
  if (params.size !== 4) throw new Error("Invalid Google consent request");
  const scopes: BoundaryValue = JSON.parse(params.get("scopes") ?? "null");
  const request = requestSchema.parse({
    clientId: params.get("clientId"),
    scopes,
    state: params.get("state"),
    expiresAt: Number(params.get("expiresAt")),
  });
  const state = parseNativeImplicitState(request.state);
  if (
    state.p !== "google" ||
    !Number.isFinite(now) ||
    request.expiresAt <= now ||
    request.expiresAt - now > 600_000
  )
    throw new Error("Google consent request expired or mismatched");
  return request;
}
