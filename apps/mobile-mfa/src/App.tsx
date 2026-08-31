import type { ReactNode } from "react";
import { useState } from "react";
import { Approval } from "./Approval.js";
import { DeviceApproval } from "./DeviceApproval.js";
import { Enrolment } from "./Enrolment.js";
import { OutcomePanel } from "./OutcomePanel.js";
import { TokenField } from "./TokenField.js";
import { readOpenedLink } from "./link.js";

/**
 * Mobile MFA — an approval surface first, an enrolment surface second.
 *
 * This app used to be four independent forms stacked on one page: approve a
 * device code, paste a principal id, paste a token, enrol an authenticator. A
 * deep link pre-filled one of the four and tinted its border, and the person
 * holding the phone still had to work out which of the four the link was
 * about.
 *
 * ADR 0086 replaced that with one question: *this specific request is waiting
 * on another device*. So the link decides the screen. Opened on an interaction
 * reference, the approval is the page and everything else folds away; opened on
 * nothing, the enrolment surface is the page. Nothing is ever both.
 */

/** The page frame every mode shares. */
function Shell({ children }: { children: ReactNode }) {
  return (
    <main className="mfa">
      <p className="brand">OpenSesame</p>
      {children}
    </main>
  );
}

/** Enrolment, folded away when a decision is on screen. */
function EnrolmentDisclosure({ token }: { token: string }) {
  return (
    <details className="disclosure">
      <summary>Authenticators</summary>
      <Enrolment token={token} />
    </details>
  );
}

export function App() {
  /**
   * Read once, during the first render, and never again.
   *
   * Before any effect and therefore before any request, which is what makes
   * the fragment scrub inside `readOpenedLink` a guarantee rather than a race.
   * The old app re-read the link on `hashchange` and `popstate` while parsing
   * only query parameters — a listener that could not fire for the thing it
   * parsed, and a second entry point into a ceremony that should have exactly
   * one.
   */
  const [link] = useState(readOpenedLink);
  const [token, setToken] = useState("");

  if (link.kind === "interaction") {
    return (
      <Shell>
        <Approval
          interactionRef={link.ref}
          token={token}
          onTokenChange={setToken}
        />
        <EnrolmentDisclosure token={token} />
      </Shell>
    );
  }

  if (link.kind === "legacy") {
    return (
      <Shell>
        <DeviceApproval
          initialUserCode={link.userCode}
          {...(link.claimId === undefined ? {} : { claimId: link.claimId })}
          token={token}
          onTokenChange={setToken}
          ownsTokenField={true}
          lead={true}
        />
        <EnrolmentDisclosure token={token} />
      </Shell>
    );
  }

  if (link.kind === "refused") {
    return (
      <Shell>
        {/* No retry, no "open anyway". A link carrying credential material is
            not a link with a recoverable problem — acting on it is the
            problem — and the only useful thing this screen can do is refuse
            and say where a real one comes from. */}
        <OutcomePanel outcome="refused">
          <p className="hint">
            That link carried credential material. Start the request again from
            the device that asked.
          </p>
        </OutcomePanel>
        <EnrolmentDisclosure token={token} />
      </Shell>
    );
  }

  return (
    <Shell>
      <h1>Mobile MFA</h1>
      <section>
        <h2>Session</h2>
        <TokenField value={token} onChange={setToken} />
      </section>
      <DeviceApproval
        token={token}
        onTokenChange={setToken}
        ownsTokenField={false}
        lead={false}
      />
      <Enrolment token={token} />
    </Shell>
  );
}
