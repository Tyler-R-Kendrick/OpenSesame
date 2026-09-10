import { type Dispatch, type SetStateAction, useEffect, useRef } from "react";
import type { CapabilityId } from "../../lib/capabilities.js";
import {
  startGithubAppRegistration,
  submitGithubAppManifest,
} from "../../lib/connections.js";
import { ensureHostSession } from "../../lib/identity.js";

export type ConnectorFlash = { tone: "ok" | "err" | "warn"; text: string };

export function useGithubAppDeployment(
  setBusy: Dispatch<SetStateAction<CapabilityId | null>>,
  setFlash: Dispatch<SetStateAction<ConnectorFlash | null>>,
) {
  const lifetime = useRef<AbortController | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    lifetime.current = controller;
    return () => controller.abort();
  }, []);
  return async (id: CapabilityId) => {
    const signal = lifetime.current?.signal;
    if (!signal || signal.aborted) return;
    setBusy(id);
    setFlash(null);
    try {
      await ensureHostSession();
      signal.throwIfAborted();
      const registration = await startGithubAppRegistration({
        returnTo: `${window.location.origin}${import.meta.env.BASE_URL.replace(/\/?$/, "/")}settings`,
        displayName: "OpenSesame History",
      });
      signal.throwIfAborted();
      setFlash({
        tone: "ok",
        text: "Sending you to GitHub to create the app…",
      });
      submitGithubAppManifest(registration);
      // Recover only while this panel still owns the attempted navigation.
      const timer = window.setTimeout(() => {
        setBusy((current) => (current === id ? null : current));
        setFlash({
          tone: "err",
          text: "GitHub did not open. This page must allow form posts to github.com (CSP form-action). Hard-refresh and try again.",
        });
      }, 2500);
      signal.addEventListener("abort", () => window.clearTimeout(timer), {
        once: true,
      });
    } catch (error) {
      if (signal.aborted) return;
      setFlash({
        tone: "err",
        text:
          error instanceof Error
            ? error.message
            : "Could not start GitHub App registration.",
      });
      setBusy(null);
    }
  };
}
