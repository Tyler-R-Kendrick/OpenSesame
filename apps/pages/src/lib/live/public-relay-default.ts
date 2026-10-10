/**
 * Build-time default for an optional hosted TURN REST relay (D3). Empty when
 * `VITE_LIVE_PUBLIC_RELAY_URL` is unset — ADR 0150 default-deny stands.
 */

export type PublicRelayBuildDefault = Readonly<{
  /** HTTPS origin of the operator's Vercel relay API, if stamped at build. */
  relayApiOrigin: string;
}>;

export function publicRelayBuildDefault(): PublicRelayBuildDefault {
  const relayApiOrigin =
    typeof import.meta.env.VITE_LIVE_PUBLIC_RELAY_URL === "string"
      ? import.meta.env.VITE_LIVE_PUBLIC_RELAY_URL.trim()
      : "";
  return { relayApiOrigin };
}
