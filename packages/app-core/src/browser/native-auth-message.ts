import { z } from "zod";

/** Authorization codes travel only on a state-scoped, same-origin return channel. */
export type NativeAuthCode = {
  state: string;
  code: string | null;
  error: boolean;
};

export function nativeAuthState(state: string): void {
  if (
    state.length < 16 ||
    state.length > 512 ||
    Array.from(state).some((character) => {
      const value = character.charCodeAt(0);
      return value <= 32 || value === 127;
    })
  )
    throw new Error("Invalid provider authorization state");
}

export function nativeAuthCallbackUrl(value: string): string {
  const url = new URL(value);
  const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (
    url.origin !== window.location.origin ||
    (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  )
    throw new Error(
      "The authorization callback must use this app's exact origin",
    );
  return url.href;
}

export async function nativeAuthChannel(state: string): Promise<string> {
  nativeAuthState(state);
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(state),
  );
  return `opensesame.auth.${Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("")}`;
}

export function nativeAuthRandom(): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(32)), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

const codeResponse = z.object({
  state: z.string().min(16).max(512),
  code: z.string().min(1).max(4096).nullable().optional(),
  error: z.union([z.boolean(), z.string().min(1).max(256)]).optional(),
});
export type NativeAuthWireCode = z.input<typeof codeResponse>;
const broadcastResponse = codeResponse.extend({
  kind: z.literal("authorization-code"),
  redirectUri: z.string().url().max(2048),
  receipt: z.string().regex(/^[a-f0-9]{64}$/),
});
export type NativeAuthBroadcast = z.input<typeof broadcastResponse>;
const acknowledgement = z.object({
  kind: z.literal("accepted"),
  receipt: z.string().regex(/^[a-f0-9]{64}$/),
});
export type NativeAuthAcknowledgement = z.input<typeof acknowledgement>;

export function parseNativeAuthAcknowledgement(
  value: NativeAuthAcknowledgement,
) {
  const parsed = acknowledgement.safeParse(value);
  return parsed.success ? parsed.data : null;
}
export function parseNativeAuthBroadcast(value: NativeAuthBroadcast) {
  const parsed = broadcastResponse.safeParse(value);
  return parsed.success ? parsed.data : null;
}
export function parseNativeAuthCode(
  value: NativeAuthWireCode,
): NativeAuthCode | null {
  const parsed = codeResponse.safeParse(value);
  if (!parsed.success) return null;
  const response = parsed.data;
  try {
    nativeAuthState(response.state);
  } catch {
    return null;
  }
  const code = response.code ?? null;
  const error = Boolean(response.error);
  if (!!code === error || (code?.length ?? 0) > 4096) return null;
  return { state: response.state, code, error };
}

export function captureNativeAuthCode(url: URL): NativeAuthCode | null {
  for (const name of ["code", "state", "error"])
    if (url.searchParams.getAll(name).length > 1) return null;
  return parseNativeAuthCode({
    state: url.searchParams.get("state") ?? "",
    code: url.searchParams.get("code"),
    error: url.searchParams.has("error"),
  });
}
