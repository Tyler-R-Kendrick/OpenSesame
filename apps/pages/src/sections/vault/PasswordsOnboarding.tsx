import { useCallback, useState } from "react";
import { useComposition } from "../../bindings/capabilities.js";
import { FailureNotice } from "../../components/FailureNotice.js";
import { IconLogin } from "../../components/Icons.js";
import { pwaOfferPasswordsOnboarding } from "../../lib/pwa-offer-passwords-onboarding.js";
import { useAddEntry } from "./add-menu.js";
import {
  commitPasswordsOnboarding,
  passwordsOfferNeeded,
} from "./passwords-onboarding.js";

export type PasswordsOnboardingPlacement = "buffer" | "add-menu";

function AddMenuEntry({ run }: { run: () => void }) {
  useAddEntry({
    id: "passwords-onboarding",
    label: "Passwords",
    order: 5,
    run,
  });
  return null;
}

/** The one-step fresh-vault offer, in the empty buffer or the Add menu. */
export function PasswordsOnboarding({
  placement,
}: {
  placement: PasswordsOnboardingPlacement;
}) {
  const snapshot = useComposition();
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const offered =
    pwaOfferPasswordsOnboarding() && passwordsOfferNeeded(snapshot);

  const accept = useCallback(() => {
    if (busy) return;
    setBusy(true);
    void commitPasswordsOnboarding(snapshot)
      .then(setNotice)
      .catch((error: unknown) => {
        setNotice(
          error instanceof Error
            ? error.message
            : "Passwords could not be turned on.",
        );
      })
      .finally(() => setBusy(false));
  }, [busy, snapshot]);

  if (!offered) return null;
  const failure = (
    <FailureNotice
      id={`vault:passwords-onboarding-${placement}`}
      title="Passwords"
      message={notice}
    />
  );
  if (placement === "add-menu") {
    return (
      <>
        <AddMenuEntry run={accept} />
        {failure}
      </>
    );
  }
  return (
    <>
      <div className="buffer__line">
        <button
          type="button"
          className="icon-btn icon-btn--sm"
          aria-label="Passwords"
          title="Passwords"
          disabled={busy}
          onClick={accept}
        >
          <IconLogin size={15} />
        </button>
      </div>
      {failure}
    </>
  );
}
