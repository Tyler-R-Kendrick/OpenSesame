import {
  type AuthenticatorInvocationKind,
  isAuthenticatorInvocationKind,
  parseAuthenticatorInvocation,
} from "@opensesame/ceremony-kit";
import { useMemo } from "react";
import { Link, useLocation, useParams } from "react-router";

const LABEL = {
  mfa: "Approve with OpenSesame",
  oid4vp: "Present a credential with OpenSesame",
  oid4vci: "Add a credential to OpenSesame",
} satisfies Record<AuthenticatorInvocationKind, string>;

export function AuthenticatorInvocation() {
  const { kind: rawKind } = useParams();
  const { search } = useLocation();
  const parsed = useMemo(() => {
    if (!isAuthenticatorInvocationKind(rawKind))
      return { error: "Unknown authenticator request." } as const;
    try {
      return {
        request: parseAuthenticatorInvocation(rawKind, search),
      } as const;
    } catch (error) {
      return {
        error:
          error instanceof Error
            ? error.message
            : "This authenticator link is invalid.",
      } as const;
    }
  }, [rawKind, search]);

  if ("error" in parsed) {
    return (
      <section className="panel">
        <div className="badge">Request refused</div>
        <h1>OpenSesame did not open</h1>
        <p>{parsed.error}</p>
        <p className="fine">
          Ask the sender for a fresh link. Do not paste tokens or secrets here.
        </p>
      </section>
    );
  }

  const { request } = parsed;
  return (
    <section className="panel">
      <div className="badge">OpenSesame authenticator</div>
      <h1>{LABEL[request.kind]}</h1>
      <p>
        This page contains only a request handle
        {request.requestHost ? ` for ${request.requestHost}` : ""}. OpenSesame
        will authenticate you and show the exact account, issuer, verifier, and
        requested data before continuing.
      </p>
      <p>
        <a className="button" href={request.appUrl}>
          Open OpenSesame
        </a>
      </p>
      {request.browserFallback ? (
        <p>
          <Link to={request.browserFallback}>Continue in this browser</Link>
        </p>
      ) : (
        <p className="fine">
          If the app is not installed, keep this page open and scan the original
          request from an OpenSesame device. Protocol credentials are never
          processed by this fallback page.
        </p>
      )}
    </section>
  );
}
