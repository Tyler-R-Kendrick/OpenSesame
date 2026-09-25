/**
 * `/invoke/:kind` (ADR 0140 plan step 10): the authenticator hand-off, moved
 * here from `apps/ceremonies`. A link names a request by reference — an MFA
 * user code or request id, or a wallet protocol's request URI — and this
 * screen hands it to the native app as ceremony-kit built the link, and for
 * an MFA user code also offers the browser ceremony the spec names as its
 * fallback (`/device`, which takes the code from its own address into
 * memory, as it does for any device link).
 *
 * The handle left the address at boot (`app-core/lib/invoke-link.ts`) and is
 * held in memory. Nothing here calls anything: no Identity API, no vault,
 * and a `request_uri` or credential offer is never fetched — the app reads
 * it. Nothing navigates to a custom scheme by itself either: the person
 * presses the key, as they did in `apps/ceremonies`. A refused link is the
 * parser's words on a mark, and in the tray.
 *
 * Loaded only on this route (`lazy-routes.tsx`).
 */

import {
  captureInvocationArrivalFromPage,
  peekInvocationArrival,
} from "@opensesame/app-core/lib/invoke-link.js";
import {
  INVOCATION_LABELS,
  type InvocationEntry,
  invocationEntry,
  reportInvocation,
} from "@opensesame/app-core/lib/invoke-route.js";
import { useEffect, useRef, useState } from "react";
import { Link, useLocation, useNavigate } from "react-router";
import { IconExternal, IconSite } from "../../components/Icons.js";
import { StatusMark } from "../../components/StatusMark.js";
import { keyboardIsIdle, landFocus } from "../../lib/focus.js";

type Handoff = Extract<InvocationEntry, { kind: "handoff" }>["invocation"];

/** Land on `element` unless the person already holds the keyboard elsewhere. */
function useArrivalFocus(element: { current: HTMLElement | null }) {
  // biome-ignore lint/correctness/useExhaustiveDependencies: once, on arrival
  useEffect(() => {
    const onLandmark =
      document.activeElement === document.getElementById("main");
    if (keyboardIsIdle() || onLandmark) landFocus(element.current);
  }, []);
}

function HandOff({ invocation }: { invocation: Handoff }) {
  const go = useRef<HTMLAnchorElement | null>(null);
  useArrivalFocus(go);
  const shown = invocation.requestHost ?? invocation.handle;
  return (
    <section
      className="panel"
      aria-label={INVOCATION_LABELS.title[invocation.kind]}
    >
      <div className="panel__body">
        <dl className="kv">
          <div>
            <dt>{INVOCATION_LABELS.handle[invocation.handleName]}</dt>
            <dd>
              <code>{shown}</code>
            </dd>
          </div>
        </dl>
        <div className="go-row">
          <a
            ref={go}
            className="go"
            href={invocation.appUrl}
            aria-label={INVOCATION_LABELS.open}
            title={INVOCATION_LABELS.open}
          >
            <IconExternal size={18} />
          </a>
          <span className="go-verb" aria-hidden="true">
            {INVOCATION_LABELS.open}
          </span>
          {invocation.browserFallback ? (
            <Link
              className="icon-btn"
              to={invocation.browserFallback}
              aria-label={INVOCATION_LABELS.fallback}
              title={INVOCATION_LABELS.fallback}
            >
              <IconSite size={16} />
            </Link>
          ) : null}
        </div>
      </div>
    </section>
  );
}

function Refused({ words }: { words: string }) {
  const root = useRef<HTMLElement | null>(null);
  useArrivalFocus(root);
  return (
    <section
      className="panel"
      aria-label={INVOCATION_LABELS.refused}
      ref={root}
      tabIndex={-1}
    >
      <div className="panel__head">
        <h2>
          {INVOCATION_LABELS.refused} <StatusMark tone="err" label={words} />
        </h2>
      </div>
    </section>
  );
}

/** Which hand-off this address opens, read once per mount. */
function useEntry(): InvocationEntry {
  const location = useLocation();
  const navigate = useNavigate();
  const [entry] = useState(() => {
    // An in-app navigation never passed through boot: read it here, the
    // same way, before anything is drawn.
    captureInvocationArrivalFromPage();
    return invocationEntry(peekInvocationArrival(), location.pathname);
  });
  // biome-ignore lint/correctness/useExhaustiveDependencies: runs once, on arrival
  useEffect(() => {
    if (entry.kind === "refused") reportInvocation(entry.words);
    if (location.search || location.hash) {
      navigate(location.pathname, { replace: true });
    }
  }, []);
  return entry;
}

export function InvokeScreen() {
  const entry = useEntry();
  const title =
    entry.kind === "handoff"
      ? INVOCATION_LABELS.title[entry.invocation.kind]
      : INVOCATION_LABELS.heading;
  return (
    <div className="section__inner">
      <div className="section__head">
        <h1>{title}</h1>
      </div>
      {entry.kind === "handoff" ? (
        <HandOff invocation={entry.invocation} />
      ) : (
        <Refused words={entry.words} />
      )}
    </div>
  );
}
