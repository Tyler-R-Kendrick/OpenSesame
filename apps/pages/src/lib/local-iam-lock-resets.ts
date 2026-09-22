/**
 * The in-memory evidence local IAM holds — unspent passkey authentications,
 * local identity sessions, pending application authorizations — is dropped
 * on vault lock. Those lock-bus subscriptions used to be made at module
 * load (`lib/local-passkeys.ts:60`, `lib/local-sessions.ts:52`,
 * `lib/local-authorization.ts:45`, `lib/local-agent-auth.ts:29`); they are
 * bound here from `activate` instead, and unbinding also resets once, so
 * disposing the capability never leaves a session, an open agent challenge
 * or an unspent authentication behind.
 */

import { bindLocalAgentAuthLockReset } from "./local-agent-auth.js";
import { bindLocalAuthorizationLockReset } from "./local-authorization.js";
import { bindLocalAuthenticationLockReset } from "./local-passkeys.js";
import { bindLocalSessionLockReset } from "./local-sessions.js";

/** Bind every lock reset; the returned unbind resets and is idempotent. */
export function bindLocalIamLockResets(): () => void {
  const unbinds = [
    bindLocalAuthenticationLockReset(),
    bindLocalSessionLockReset(),
    bindLocalAuthorizationLockReset(),
    bindLocalAgentAuthLockReset(),
  ];
  let done = false;
  return () => {
    if (done) return;
    done = true;
    for (const unbind of unbinds) unbind();
  };
}
