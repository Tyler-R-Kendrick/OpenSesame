import { useEffect, useState } from "react";
import { readFragmentToken } from "../lib/deep-link.js";

/**
 * Connection-delegation claim (ADR 0044) — the ceremony that will let a guest
 * or agent accept delegated connector authority. The backend (delegation
 * offers, `osc_dlg_` spend, child grants) is ADR 0044 Phases 1–2 and has not
 * landed, so this page holds the link discipline only: it takes the token out
 * of the URL immediately and explains what will happen here. It makes no
 * network calls.
 */
export function DelegateClaim() {
  const [hasToken, setHasToken] = useState(false);

  useEffect(() => {
    // Same fragment discipline as every ceremony: the bearer leaves the URL
    // before anything else happens, so history and referrers never carry it.
    // It is deliberately NOT stashed: nothing can spend it yet, and a bearer
    // nothing can use should not outlive this render.
    const token = readFragmentToken(window.location.hash);
    if (token) {
      history.replaceState(
        null,
        "",
        `${window.location.pathname}${window.location.search}`,
      );
      setHasToken(true);
    }
  }, []);

  return (
    <section className="panel">
      <div className="badge">Accept delegated access</div>
      <h1>Accept delegated connector access</h1>
      <p>
        Someone wants to share access to a connection (or a set of them) with
        you — without ever handing over their credentials. You would review
        exactly what is offered, accept, and use it through OpenSesame while the
        owner can revoke at any time.
      </p>
      {hasToken ? (
        <output className="err" role="alert">
          This delegation link is valid in shape, but delegation claims are not
          live yet (ADR 0044, phases 1–2). The token was removed from the URL
          and discarded — ask the sender for a fresh link once the feature
          ships.
        </output>
      ) : (
        <output className="lede">
          Delegation claims are not live yet (ADR 0044, phases 1–2). When they
          ship, links shared with you open here as{" "}
          <code>/delegate#token=osc_dlg_…</code>.
        </output>
      )}
    </section>
  );
}
