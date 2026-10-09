/** One bounded Vault/OpenBao KV v2 request; callers retain their own sealed authority checks. */
import { type BoundaryObject, overlapCast } from "@opensesame/os-domain";
import { z } from "zod";
import { NativeApiError, nativeApiHttp } from "./native-api-http.js";
import type { NativeProviderTransport } from "./native-connector-transport.js";
import {
  nativeLocalInstanceHeaders,
  nativeLocalInstanceOrigin,
} from "./native-local-instance-http.js";
export interface NativeVaultKvRead {
  mount: string;
  path: string;
  version?: number;
}
export interface NativeVaultKvData {
  data: BoundaryObject;
  metadata: { version: number };
}
export function vaultKvPath(input: NativeVaultKvRead) {
  const segment = /^[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)*$/;
  if (
    !segment.test(input.mount) ||
    !segment.test(input.path) ||
    input.mount.length > 256 ||
    input.path.length > 1024 ||
    [...input.mount.split("/"), ...input.path.split("/")].some((part) =>
      [".", ".."].includes(part),
    )
  )
    throw new Error("Enter a KV mount and secret path without traversal");
  if (
    input.version !== undefined &&
    (!Number.isSafeInteger(input.version) || input.version < 1)
  )
    throw new Error("Select a positive KV version");
  return `${input.mount}/data/${input.path}`;
}
export async function readNativeVaultKv(
  endpoint: string,
  namespace: string,
  token: string,
  read: NativeVaultKvRead,
  transport: NativeProviderTransport,
): Promise<NativeVaultKvData> {
  const path = vaultKvPath(read);
  const url = new URL(`${nativeLocalInstanceOrigin(endpoint)}/v1/${path}`);
  if (read.version !== undefined)
    url.searchParams.set("version", String(read.version));
  const reply = await nativeApiHttp(
    {
      url,
      method: "GET",
      headers: nativeLocalInstanceHeaders(token, namespace),
    },
    transport,
  );
  const parsed = z
    .object({
      data: z.object({
        data: z.record(z.string(), z.unknown()),
        metadata: z.object({ version: z.number().int().positive() }),
      }),
    })
    .safeParse(reply);
  if (!parsed.success) throw new NativeApiError("response");
  transport.assertCurrent();
  return {
    data: overlapCast(parsed.data.data.data),
    metadata: parsed.data.data.metadata,
  };
}
