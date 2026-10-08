import { bytesToB64url } from "@opensesame/sdk-browser";
import { assertNotDecoySession } from "../decoy-session.js";

type LocalClaimAuthority = Readonly<{
  check: () => void;
  wait: <T>(work: Promise<T>) => Promise<T>;
  digest: (parts: string[]) => Promise<string>;
}>;

/** Origin claims remain usable while locked, but never cross realm changes. */
export function captureLocalClaimAuthority(): LocalClaimAuthority {
  const generation = assertNotDecoySession();
  const check = (): void => {
    assertNotDecoySession(generation);
  };
  const wait = async <T>(work: Promise<T>): Promise<T> => {
    try {
      return await work;
    } finally {
      check();
    }
  };
  return {
    check,
    wait,
    async digest(parts: string[]): Promise<string> {
      check();
      const joined = new TextEncoder().encode(parts.join("\0"));
      const digest = await wait(crypto.subtle.digest("SHA-256", joined));
      return bytesToB64url(new Uint8Array(digest));
    },
  };
}
