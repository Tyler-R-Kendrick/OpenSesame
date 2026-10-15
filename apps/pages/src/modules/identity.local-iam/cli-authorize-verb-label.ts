import { cliAppIntegrationPolicy } from "@opensesame/app-core/lib/cli-app-integration/index.js";

const VERB_LABELS: Readonly<Record<string, string>> = {
  run: "Run",
  "daemon-pin-probe": "Daemon check",
};

export function isCliAuthorizeProbeVerb(verb: string): boolean {
  return verb === cliAppIntegrationPolicy.daemonPinProbeVerb;
}

/** Human-facing label for a pending CLI verb (never shown for pin probes). */
export function cliAuthorizeVerbLabel(verb: string): string {
  const mapped = VERB_LABELS[verb];
  if (mapped) return mapped;
  if (verb.includes("-")) {
    return verb
      .split("-")
      .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
      .join(" ");
  }
  return verb.charAt(0).toUpperCase() + verb.slice(1);
}
