/** Vault/OpenBao use one selected origin and two fixed token-owned paths. */
import { z } from "zod";
import { NativeApiError, nativeApiHttp } from "./native-api-http.js";
import type { NativeProviderTransport } from "./native-connector-transport.js";

const TokenLookup = z.object({
  data: z.object({
    display_name: z.string().max(256).optional(),
    entity_id: z.string().max(256).optional(),
    policies: z.array(z.string().min(1).max(256)).max(128),
    ttl: z.number().finite().nonnegative().max(315360000),
    renewable: z.boolean(),
  }),
});
export interface NativeLocalInstanceFacts {
  entityId: string | null;
  tokenLabel: string;
  policies: string[];
  renewable: boolean;
  expiresAt: number | null;
  verifiedAt: number;
}
export function nativeLocalInstanceOrigin(input: string): string {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    throw new Error("Enter the instance's HTTPS origin");
  }
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== "/"
  )
    throw new Error(
      "Enter the instance's HTTPS origin without a path or credentials",
    );
  return url.origin;
}
export function nativeLocalInstanceHeaders(
  token: string,
  namespace: string,
): Headers {
  if (!/^[!-~]{1,32768}$/.test(token))
    throw new Error("Enter a valid provider token");
  if (namespace && !/^[A-Za-z0-9_/-]{1,256}$/.test(namespace))
    throw new Error(
      "Enter a provider namespace using letters, numbers, dashes and slashes",
    );
  const headers = new Headers({ "X-Vault-Token": token });
  if (namespace) headers.set("X-Vault-Namespace", namespace);
  return headers;
}
export async function lookupNativeLocalInstance(
  endpoint: string,
  namespace: string,
  token: string,
  transport: NativeProviderTransport,
): Promise<NativeLocalInstanceFacts> {
  const origin = nativeLocalInstanceOrigin(endpoint);
  const result = await nativeApiHttp(
    {
      url: `${origin}/v1/auth/token/lookup-self`,
      method: "GET",
      headers: nativeLocalInstanceHeaders(token, namespace),
    },
    transport,
  );
  const parsed = TokenLookup.safeParse(result);
  if (!parsed.success) throw new NativeApiError("response");
  const { data } = parsed.data;
  const labels = [
    data.entity_id ?? "",
    data.display_name ?? "",
    ...data.policies,
  ];
  if (labels.some((label) => label.includes(token)))
    throw new NativeApiError("response");
  const verifiedAt = Date.now();
  return {
    entityId: data.entity_id || null,
    tokenLabel: data.display_name ?? "Provider token",
    policies: data.policies,
    renewable: data.renewable,
    expiresAt: data.ttl === 0 ? null : verifiedAt + data.ttl * 1000,
    verifiedAt,
  };
}
export async function revokeNativeLocalInstanceSelf(
  endpoint: string,
  namespace: string,
  token: string,
  transport: NativeProviderTransport,
): Promise<void> {
  const origin = nativeLocalInstanceOrigin(endpoint);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15_000);
  transport.assertCurrent();
  try {
    const response = await transport.fetch(
      `${origin}/v1/auth/token/revoke-self`,
      {
        method: "POST",
        headers: nativeLocalInstanceHeaders(token, namespace),
        signal: controller.signal,
        credentials: "omit",
        redirect: "error",
        cache: "no-store",
        referrerPolicy: "no-referrer",
        mode: "cors",
      },
    );
    transport.assertCurrent();
    if (response.status === 401) throw new NativeApiError("authorization", 401);
    if (response.status === 403) throw new NativeApiError("permission", 403);
    if (!response.ok || response.redirected)
      throw new NativeApiError("response", response.status);
    await response.body?.cancel().catch(() => undefined);
    if (controller.signal.aborted) throw new NativeApiError("network");
    transport.assertCurrent();
  } catch (error) {
    if (error instanceof NativeApiError) throw error;
    throw new NativeApiError("network");
  } finally {
    clearTimeout(timer);
  }
}
