import { useEffect, useRef } from "react";
import {
  type Provider,
  startGithubAppRegistration,
  submitGithubAppManifest,
} from "../../lib/connections.js";
import { type Flash, errorText } from "./shared.js";

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
    return () => {
      generation.current += 1;
      window.clearTimeout(timeout.current);
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
      onFlash({ tone: "ok", text: "Sending you to GitHub to create the app…" });
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
