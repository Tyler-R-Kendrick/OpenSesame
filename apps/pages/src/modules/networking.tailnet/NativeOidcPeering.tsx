import {
  nativeOidcPeering,
  subscribeNativeOidcPeering,
} from "@opensesame/app-core/browser/identity-oidc-dispatch.js";
import { type ReactNode, useSyncExternalStore } from "react";
import { CeremonySheet } from "../../components/CeremonySheet.js";
import { CeremonyShell } from "../../components/CeremonyShell.js";
import { FormCommit } from "../../components/FormCommit.js";
import { IconConnection } from "../../components/Icons.js";
import { StatusMark } from "../../components/StatusMark.js";

/** Available on locked screens and in the shell only while Networking is enabled. */
export function NativeOidcPeeringGate() {
  const prompt = useSyncExternalStore(
    subscribeNativeOidcPeering,
    nativeOidcPeering,
    nativeOidcPeering,
  );
  if (!prompt) return null;
  const { state, node } = prompt;
  return (
    <CeremonySheet
      title="Connect identity browser node"
      mark={<IconConnection size={18} />}
      onClose={prompt.cancel}
    >
      <CeremonyShell
        name={prompt.label}
        facts={[
          { key: "Control server", value: state.controlURL },
          { key: "Browser node", value: state.hostname },
        ]}
      >
        {state.status === "login" && !state.authURL ? (
          <FormCommit
            label="Sign in to Tailscale"
            onClick={() => node.login()}
          />
        ) : null}
        {state.authURL ? (
          <a href={state.authURL} target="_blank" rel="noreferrer noopener">
            Continue signing in with Tailscale
          </a>
        ) : null}
        {state.status === "approval" ? (
          <StatusMark
            tone="err"
            label="Approve this browser node in your Tailscale admin console."
          />
        ) : null}
        {state.failure ? <StatusMark tone="err" label={state.failure} /> : null}
      </CeremonyShell>
    </CeremonySheet>
  );
}
export function NativeOidcPeeringWrapper({
  children,
}: { children?: ReactNode }) {
  return (
    <>
      {children}
      <NativeOidcPeeringGate />
    </>
  );
}
