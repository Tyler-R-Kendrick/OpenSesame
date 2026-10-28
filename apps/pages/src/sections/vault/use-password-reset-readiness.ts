import { browserInference } from "@opensesame/app-core/lib/browser-inference.js";
import {
  loadModelProvider,
  resolveModelPlane,
} from "@opensesame/app-core/lib/model-provider.js";
import {
  type PasswordResetReadiness,
  evaluatePasswordResetReadiness,
} from "@opensesame/app-core/lib/password-reset/readiness.js";
import { useEffect, useState } from "react";
import { useComposition } from "../../bindings/capabilities.js";

export function usePasswordResetReadiness(): PasswordResetReadiness | null {
  const { plan } = useComposition();
  const [ready, setReady] = useState<PasswordResetReadiness | null>(null);
  useEffect(() => {
    let cancelled = false;
    const approved = plan?.approvedCapabilities;
    void (async () => {
      const verdict = await browserInference();
      const plane = resolveModelPlane(loadModelProvider(), verdict);
      const next = await evaluatePasswordResetReadiness(approved, plane);
      if (!cancelled) setReady(next);
    })();
    return () => {
      cancelled = true;
    };
  }, [plan]);
  return ready;
}
