import { Redacted } from "effect";
import { EgressDenied } from "./capabilities/egress.js";
import { NativeApiError } from "./native-api-http.js";
import { safeProviderText } from "./native-api-verify.js";
import type { NativeProviderTransport } from "./native-connector-transport.js";
import type { NativeS3Target } from "./native-s3-input.js";
import { keysOf } from "./secret-fs/s3-listing.js";
import { EMPTY_PAYLOAD, signS3 } from "./secret-fs/s3-sigv4.js";

function signingCredentials(target: NativeS3Target) {
  return {
    accessKeyId: target.parameters.access_key_id ?? "",
    secretAccessKey: Redacted.make(target.credentials.secret_access_key ?? ""),
    sessionToken: target.credentials.session_token
      ? Redacted.make(target.credentials.session_token)
      : undefined,
  };
}

async function boundedXml(response: Response): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) throw new NativeApiError("response");
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      size += next.value.byteLength;
      if (size > 256 * 1024) throw new NativeApiError("response");
      chunks.push(next.value);
    }
    const body = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      body.set(chunk, offset);
      offset += chunk.length;
    }
    return new TextDecoder("utf-8", { fatal: true }).decode(body);
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

function element(xml: string, name: string): string {
  const matches = [
    ...xml.matchAll(
      new RegExp(`<${name}(?:>([\\s\\S]*?)<\\/${name}>|\\s*\\/>)`, "g"),
    ),
  ];
  if (matches.length !== 1) throw new NativeApiError("response");
  return (
    keysOf(`<Contents><Key>${matches[0]?.[1] ?? ""}</Key></Contents>`)[0] ?? ""
  );
}
function listing(xml: string, target: NativeS3Target) {
  if (
    !/^\s*(?:<\?xml[^?]*\?>\s*)?<ListBucketResult(?:\s+xmlns="https?:\/\/s3.amazonaws.com\/doc\/2006-03-01\/"|\s+xmlns="")?\s*>[\s\S]*<\/ListBucketResult>\s*$/.test(
      xml,
    ) ||
    /<!|<Error\b/.test(xml)
  )
    throw new NativeApiError("response");
  if (
    element(xml, "Name") !== target.parameters.bucket ||
    element(xml, "Prefix") !== target.parameters.prefix ||
    !["true", "false"].includes(element(xml, "IsTruncated"))
  )
    throw new NativeApiError("response");
  const keys = keysOf(xml);
  if (
    keys.length > 100 ||
    keys.some(
      (key) =>
        !key.startsWith(target.parameters.prefix ?? "") ||
        key.length > 1024 ||
        !/^[^\p{Cc}]*$/u.test(key),
    )
  )
    throw new NativeApiError("response");
  return keys.map((key) => ({
    id: key,
    label: safeProviderText(key, target.credentials),
  }));
}

/** One bounded ListObjectsV2 proves bucket permission, never account ownership. */
export async function readNativeS3Bucket(
  target: NativeS3Target,
  transport: NativeProviderTransport,
) {
  transport.assertCurrent();
  const url = new URL(
    `${target.parameters.endpoint}/${target.parameters.bucket}/`,
  );
  url.searchParams.set("list-type", "2");
  url.searchParams.set("max-keys", "100");
  url.searchParams.set("prefix", target.parameters.prefix ?? "");
  const signed = signS3({
    method: "GET",
    url,
    payloadHash: EMPTY_PAYLOAD,
    region: target.parameters.region ?? "",
    credentials: signingCredentials(target),
  });
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15_000);
  try {
    const response = await transport.fetch(signed.url, {
      method: "GET",
      headers: signed.headers,
      signal: controller.signal,
      mode: "cors",
      credentials: "omit",
      redirect: "error",
      cache: "no-store",
      referrerPolicy: "no-referrer",
    });
    transport.assertCurrent();
    if (response.status === 401) throw new NativeApiError("authorization", 401);
    if (response.status === 403) throw new NativeApiError("permission", 403);
    if (!response.ok || response.redirected)
      throw new NativeApiError("response", response.status);
    const result = listing(await boundedXml(response), target);
    transport.assertCurrent();
    if (controller.signal.aborted) throw new NativeApiError("network");
    return result;
  } catch (error) {
    if (error instanceof NativeApiError) throw error;
    if (error instanceof EgressDenied) throw new NativeApiError("deployment");
    throw new NativeApiError("network");
  } finally {
    clearTimeout(timeout);
  }
}
