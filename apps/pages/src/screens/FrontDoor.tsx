/**
 * The front door — the first screen of a device nobody has set up (ADR 0115).
 *
 * Sign-in is still the first screen, and nothing gates it (ADR 0090): the
 * compiled-in broker, guest, Skip and the local-only seal are all on this
 * card, one press away. What this screen adds is the decision a first visitor
 * actually arrives with, made large: **set up your own**. On a device with
 * no vault and no setup record that road is the hero; once the ceremony has
 * been answered — or skipped — it goes back to being the quiet link in the
 * sign-in form's foot, where a returning device keeps it.
 *
 * The title is the wordmark itself, at hero scale: the same slot-reel every
 * gate runs, big enough to be the one authored moment of the screen. Nothing
 * else here moves.
 *
 * The keyboard lands on the road. Tab walks Set up → the
 * sign-in bar → guest → local-only, in document order, and Skip sits in the
 * card's corner where a skip always lives.
 */

import type { FederatedProviderSummary } from "@opensesame/app-core/lib/providers.js";
import { useEffect, useRef } from "react";
import { IconAuthority } from "../components/Icons.js";
import { ThemeToggle } from "../components/ThemeToggle.js";
import { Wordmark } from "../components/Wordmark.js";
import { landFocus } from "../lib/focus.js";
import { GuideTarget, useGuideTarget } from "../tutorial/registry/react.jsx";
import { useSupportRoute } from "../tutorial/session.js";
import { RequirementsGate } from "./capabilities/RequirementsGate.js";
import { PendingLinkBanner } from "./unlock/PendingLinkBanner.js";
import { ReleaseNotes } from "./unlock/ReleaseNotes.js";
import { SignInPanel } from "./unlock/SignInPanel.js";
import "./unlock.css";
import "./door.css";

export function FrontDoor({
  providers,
  onOpenSetup,
  onUseLocalOnly,
}: {
  providers: FederatedProviderSummary[];
  /** The operator ceremony — every tab of it optional (ADR 0114). `join`
   *  lands on a managed instance's required roots to accept. */
  onOpenSetup: (join?: boolean) => void;
  /** Seal a local vault with no account at all. */
  onUseLocalOnly: () => void;
}) {
  useSupportRoute("/unlock");
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
          <p className="door__lede">Set up your own vault.</p>
        </header>

        {/* A managed instance's required roots, when this deployment has
            any nobody has accepted yet. Never in front of sign-in. */}
        <RequirementsGate onOpenSetup={onOpenSetup} />

        <fieldset className="door__roads" aria-label="Roads in">
          {/* The name is the road; the second line describes it, so a
              screen reader hears "Set up your own" and then what it takes. */}
          <button
            ref={(element) => {
              firstRoad.current = element;
              setupRef(element);
            }}
            type="button"
            className="road"
            aria-label="Set up your own"
            aria-describedby="door-setup-kind"
            onClick={() => onOpenSetup()}
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

        <div className="door__theme">
          <ThemeToggle tabIndex={-1} />
        </div>

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
      <ReleaseNotes />
    </div>
  );
}
