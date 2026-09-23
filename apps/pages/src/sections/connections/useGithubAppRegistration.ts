import {
  type Provider,
  startGithubAppRegistration,
  submitGithubAppManifest,
} from "@opensesame/app-core/lib/connections.js";
import {
  type Flash,
  errorText,
} from "@opensesame/app-core/sections/connections/shared.js";
import { useEffect, useRef } from "react";

export function useGithubAppRegistration(
  provider: Pick<Provider, "id" | "displayName">,
  onFlash: (flash: Flash) => void,
  setBusy: (busy: "app" | null) => void,
) {
  const generation = useRef(0);
  const timeout = useRef<number | undefined>(undefined);
  useEffect(() => {
    if (provider.id !== "github") return;
    generation.current += 1;
    const onHide = () => {
      // Form navigation to github.com — do not flash a CSP failure after we left.
      generation.current += 1;
      window.clearTimeout(timeout.current);
    };
    window.addEventListener("pagehide", onHide);
    return () => {
      generation.current += 1;
      window.clearTimeout(timeout.current);
      window.removeEventListener("pagehide", onHide);
    };
  }, [provider.id]);

  return async () => {
    if (provider.id !== "github") return;
    const run = ++generation.current;
    window.clearTimeout(timeout.current);
    setBusy("app");
    try {
      const registration = await startGithubAppRegistration({
        returnTo: `${window.location.origin}${window.location.pathname}`,
        displayName: `OpenSesame ${provider.displayName}`,
      });
      if (run !== generation.current) return;
      submitGithubAppManifest(registration);
      timeout.current = window.setTimeout(() => {
        if (run !== generation.current) return;
        setBusy(null);
        onFlash({
          tone: "err",
          text: "GitHub did not open. Hard-refresh so CSP allows form posts to github.com, then try again.",
        });
      }, 2500);
    } catch (error) {
      if (run !== generation.current) return;
      onFlash({ tone: "err", text: errorText(error) });
      setBusy(null);
    }
  };
}
