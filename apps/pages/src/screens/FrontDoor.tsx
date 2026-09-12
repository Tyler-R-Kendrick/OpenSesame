/**
 * The front door — the first screen of a device nobody has set up (ADR 0115).
 *
 * Sign-in is still the first screen, and nothing gates it (ADR 0090): the
 * compiled-in broker, guest, Skip and the local-only seal are all on this
 * card, one press away. What this screen adds is the decision a first visitor
 * actually arrives with, made large: **join a session** somebody shared, or
 * **set up your own**. On a device with no vault and no setup record those
 * two roads are the hero; once the ceremony has been answered — or skipped —
 * they go back to being the quiet links in the sign-in form's foot, where a
 * returning device keeps them.
 *
 * The title is the wordmark itself, at hero scale: the same slot-reel every
 * gate runs, big enough to be the one authored moment of the screen. Nothing
 * else here moves.
 *
 * The keyboard lands on the first road. Tab walks Join → Set up → the
 * sign-in bar → guest → local-only, in document order, and Skip sits in the
 * card's corner where a skip always lives.
 */

import { useEffect, useRef } from "react";
import { IconAuthority, IconBroadcast } from "../components/Icons.js";
import { Wordmark } from "../components/Wordmark.js";
import { landFocus } from "../lib/focus.js";
import type { FederatedProviderSummary } from "../lib/providers.js";
import { GuideTarget, useGuideTarget } from "../tutorial/registry/react.jsx";
import { useSupportRoute } from "../tutorial/session.js";
import { PendingLinkBanner } from "./unlock/PendingLinkBanner.js";
import { SignInPanel } from "./unlock/SignInPanel.js";
import "./unlock.css";
import "./door.css";

export function FrontDoor({
  providers,
  onOpenJoin,
  onOpenSetup,
  onUseLocalOnly,
}: {
  providers: FederatedProviderSummary[];
  /** Join a session somebody invited this device to (ADR 0079 §7). */
  onOpenJoin: () => void;
  /** The operator ceremony — every tab of it optional (ADR 0114). */
  onOpenSetup: () => void;
  /** Seal a local vault with no account at all. */
  onUseLocalOnly: () => void;
}) {
  useSupportRoute("/unlock");
  const joinRef = useGuideTarget<HTMLButtonElement>("setup.join");
  const setupRef = useGuideTarget<HTMLButtonElement>("unlock.setup");
  const firstRoad = useRef<HTMLButtonElement | null>(null);

  // The screen owns its landing: the first road, so Enter opens it and Tab
  // walks the rest. Runs after the sign-in panel's own effect, which would
  // otherwise leave the keyboard on the first brand mark — but yields to a
  // caret: where an Identity API exists the identifier field is the one typed
  // step and already holds it, and typing must start at once.
  useEffect(() => {
    if (document.activeElement instanceof HTMLInputElement) return;
    landFocus(firstRoad.current);
  }, []);

  return (
    <div className="unlock door">
      <div className="unlock__card door__card">
        <PendingLinkBanner />
        <header className="door__hero">
          <Wordmark as="h1" className="door__wordmark" size={40} />
          <p className="door__lede">
            Join a session you were invited to, or set up your own.
          </p>
        </header>

        <fieldset className="door__roads" aria-label="Roads in">
          {/* The name is the road; the second line describes it, so a
              screen reader hears "Join a session" and then what it takes. */}
          <button
            ref={(element) => {
              firstRoad.current = element;
              joinRef(element);
            }}
            type="button"
            className="road"
            aria-label="Join a session"
            aria-describedby="door-join-kind"
            onClick={onOpenJoin}
          >
            <span className="road__mark" aria-hidden="true">
              <IconBroadcast size={20} />
            </span>
            <span className="road__name">Join a session</span>
            <span className="road__kind" id="door-join-kind">
              a link and a code
            </span>
          </button>
          <button
            ref={setupRef}
            type="button"
            className="road"
            aria-label="Set up your own"
            aria-describedby="door-setup-kind"
            onClick={onOpenSetup}
          >
            <span className="road__mark" aria-hidden="true">
              <IconAuthority size={20} />
            </span>
            <span className="road__name">Set up your own</span>
            <span className="road__kind" id="door-setup-kind">
              a few optional steps
            </span>
          </button>
        </fieldset>

        <div className="signin__divider" aria-hidden="true">
          or sign in
        </div>

        {/* The sign-in roads, whole: the broker's brand marks, guest as a
            full-size button, Skip in the corner, and the local-only seal.
            Never gated on the roads above (AGENTS.md §5). */}
        <GuideTarget id="unlock.signin">
          <SignInPanel
            placement="primary"
            providers={providers}
            onUseLocalOnly={onUseLocalOnly}
          />
        </GuideTarget>
      </div>
    </div>
  );
}
