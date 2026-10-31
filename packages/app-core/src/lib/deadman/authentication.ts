/** Original-session authentication updates; stale signatures cannot replace newer policy. */
import { kvGet, kvRefresh } from "../kv.js";
import { originalVfsCheck } from "../vfs-operation-check.js";
import { canonicalJson, signText } from "./crypto.js";
import { withDeadmanTurn } from "./fence.js";
import { deadmanStateKey } from "./keys.js";
import { sendHeartbeat } from "./relay.js";
import type { DeadmanConfig, DeadmanState } from "./state.js";

type AuthenticationHost = Readonly<{
  now: () => number;
  read: (tomb: string) => DeadmanState | null;
  verify: (state: DeadmanState) => Promise<boolean>;
  config: (tomb: string) => Promise<DeadmanConfig | null>;
  matches: (privateKey: JsonWebKey, publicKey: JsonWebKey) => Promise<boolean>;
  sign: (
    state: Omit<DeadmanState, "signature">,
    key: JsonWebKey,
  ) => Promise<DeadmanState>;
  write: (
    tomb: string,
    state: DeadmanState,
    check: () => void,
  ) => Promise<void>;
}>;

export async function recordAuthentication(
  tomb: string,
  host: AuthenticationHost,
  check?: () => void,
): Promise<void> {
  try {
    const original = originalVfsCheck(check);
    const storageKey = deadmanStateKey(tomb);
    const initial = kvGet(storageKey);
    const current = (expected: string | null) => {
      original();
      if (kvGet(storageKey) !== expected)
        throw new Error("The original deadman policy changed.");
    };
    const state = host.read(tomb);
    if (!state) return;
    const valid = await host.verify(state);
    current(initial);
    if (!valid) return;
    const config = await host.config(tomb);
    current(initial);
    if (!config || config.id !== state.id) return;
    const matched = await host.matches(
      config.privateKeyJwk,
      state.publicKeyJwk,
    );
    current(initial);
    if (!matched) return;
    const now = host.now();
    if (
      now <= state.lastAuthenticatedAt ||
      state.sequence >= Number.MAX_SAFE_INTEGER
    )
      return;
    const next = await host.sign(
      { ...state, lastAuthenticatedAt: now, sequence: state.sequence + 1 },
      config.privateKeyJwk,
    );
    current(initial);
    await withDeadmanTurn(tomb, async () => {
      current(initial);
      await kvRefresh(storageKey, 64_000, () => current(initial));
      current(initial);
      await host.write(tomb, next, () => current(initial));
      original();
    });
    const committed = JSON.stringify(next);
    current(committed);
    const heartbeat = {
      v: 1 as const,
      type: "opensesame.deadman.heartbeat" as const,
      id: next.id,
      at: now,
      sequence: next.sequence,
    };
    const signature = await signText(
      config.privateKeyJwk,
      canonicalJson(heartbeat),
    );
    current(committed);
    void sendHeartbeat(
      { relayUrl: next.relayUrl, relayToken: config.relayToken },
      { ...heartbeat, signature },
    ).catch(() => undefined);
  } catch {
    // Authentication already completed; policy/owner changes and relay failure cannot reopen it.
  }
}
