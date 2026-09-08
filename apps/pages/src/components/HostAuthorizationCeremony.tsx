import { useEffect, useRef, useState } from "react";
import {
  type HostAuthorizationRequest,
  authenticateBrowser,
  authorizeHost,
} from "../lib/host-authorization.js";
import { CeremonyShell } from "./CeremonyShell.js";
export const hostCeremonySeams = { authenticateBrowser, authorizeHost };

type AuthorizationCeremonyProps = {
  request?: HostAuthorizationRequest;
  onComplete: (elevation: string | null) => void;
  onCancel: () => void;
};

export function HostAuthorizationCeremony(props: AuthorizationCeremonyProps) {
  const request = props.request;
  const binding = request
    ? `${request.operation}:${request.target_id}:${request.transition}`
    : "authenticate";
  return <BoundHostAuthorizationCeremony key={binding} {...props} />;
}

function BoundHostAuthorizationCeremony({
  request,
  onComplete,
  onCancel,
}: AuthorizationCeremonyProps) {
  const [identified, setIdentified] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);
  const lifetime = useRef<AbortController | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    lifetime.current = controller;
    return () => controller.abort();
  }, []);
  const verify = async () => {
    const controller = lifetime.current;
    if (!controller || controller.signal.aborted || busy) return;
    setBusy(true);
    setError(false);
    try {
      const elevation =
        identified && request
          ? await hostCeremonySeams.authorizeHost(request, controller.signal)
          : await hostCeremonySeams.authenticateBrowser(controller.signal);
      if (controller.signal.aborted) return;
      if (identified || !request) onComplete(elevation);
      else setIdentified(true);
    } catch {
      if (!controller.signal.aborted) setError(true);
    } finally {
      if (!controller.signal.aborted) setBusy(false);
    }
  };
  return (
    <CeremonyShell
      ok={false}
      top={identified ? "One-use approval" : "Identity verification"}
      name={
        identified ? "Approve this control transition" : "Identify this browser"
      }
      facts={
        request
          ? [
              { key: "Run", value: request.target_id },
              {
                key: "Action",
                value: request.transition ?? "Authenticate browser",
              },
            ]
          : []
      }
      primary={{
        label: busy ? "Waiting for Identity…" : "Open Identity verification",
        onClick: () => void verify(),
        busy,
      }}
      secondary={{
        label: "Cancel",
        onClick: () => {
          lifetime.current?.abort();
          onCancel();
        },
      }}
    >
      <p className="hint">
        Your Identity window shows the exact request and asks for your passkey.
        Local pairing alone does not authorize browser control.
      </p>
      {error ? (
        <p className="hint" role="alert">
          Verification was refused or expired. Sign in on the configured
          Identity origin and check your passkey, then try again.
        </p>
      ) : null}
    </CeremonyShell>
  );
}

export function BrowserIdentityAuthorization() {
  const [open, setOpen] = useState(false);
  const [done, setDone] = useState(false);
  if (open)
    return (
      <HostAuthorizationCeremony
        onComplete={() => {
          setDone(true);
          setOpen(false);
        }}
        onCancel={() => setOpen(false)}
      />
    );
  return (
    <div>
      {done ? (
        <p className="hint">
          Identity verified for this short-lived browser grant.
        </p>
      ) : null}
      <button className="btn" type="button" onClick={() => setOpen(true)}>
        Verify browser identity
      </button>
    </div>
  );
}
