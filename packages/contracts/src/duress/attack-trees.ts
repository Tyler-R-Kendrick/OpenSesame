/**
 * REDTEAM-A: Attack trees for OpenSesame duress profiles.
 * Informative catalog — executable reproductions live under
 * packages/app-core/src/lib/duress/redteam/** and packages/redteam/src/duress/*.test.ts.
 */

export type AttackSeverity = "critical" | "high" | "medium" | "low" | "info";

export type AttackNode = Readonly<{
  id: string;
  invariant?: string;
  title: string;
  adversary: string;
  goal: string;
  preconditions: readonly string[];
  steps: readonly string[];
  expectedDefense: string;
  severityIfBroken: AttackSeverity;
}>;

export const DURESS_ATTACK_TREES: readonly AttackNode[] = [
  {
    id: "AT-COERCE-01",
    invariant: "INV-03",
    title: "Forced entry of known duress code",
    adversary: "coercer with victim present",
    goal: "Escalate beyond enrolled profile effects",
    preconditions: ["Victim knows a duress code", "Profile armed"],
    steps: [
      "Force complete code submission",
      "Observe presentation / unlock",
      "Attempt export_root / administer Access / recover root",
    ],
    expectedDefense:
      "Only enrolled profile effects; ceiling + deny list; no attempt-count auto-trigger",
    severityIfBroken: "critical",
  },
  {
    id: "AT-COERCE-02",
    invariant: "INV-07",
    title: "Partial / prefix code probing",
    adversary: "coercer",
    goal: "Discover which codes are enrolled via prefix side-channel",
    preconditions: ["UI accepts progressive digit entry"],
    steps: ["Submit short prefixes", "Watch for distinctive latency or UX"],
    expectedDefense:
      "assertTriggerCodeLength rejects incomplete; selectTrigger returns none",
    severityIfBroken: "high",
  },
  {
    id: "AT-OP-01",
    invariant: "INV-11",
    title: "Malicious operator via RBAC fallback",
    adversary: "insider with unlocked vault after duress",
    goal: "Promote to operator while restricted/decoy fence active",
    preconditions: [
      "Active incident fence",
      "Missing or cleared AccessContext",
    ],
    steps: [
      "Clear session context without clearing fence",
      "Call resolveCurrentAccessRole",
      "Administer Access / Identity",
    ],
    expectedDefense:
      "Any active restricted/decoy/locked fence forces guest; null ctx fail-closed",
    severityIfBroken: "critical",
  },
  {
    id: "AT-AGENT-01",
    invariant: "INV-32",
    title: "Agent/MCP administers duress",
    adversary: "compromised agent surface",
    goal: "Enroll trigger, export shares, or approve recovery via MCP",
    preconditions: ["Agent tools exposed"],
    steps: ["Request enrollTrigger / combineRecoveryShares / arm profile"],
    expectedDefense: "No agent/admin tools; host refuses; unsupported labeled",
    severityIfBroken: "critical",
  },
  {
    id: "AT-PEER-01",
    invariant: "INV-15",
    title: "Replay peer quarantine envelope",
    adversary: "malicious peer / MITM with captured envelope",
    goal: "Re-apply quarantine or mint effects via replay",
    preconditions: ["Valid signed envelope captured"],
    steps: ["Replay same nonce to receiver", "Alter audience after sign"],
    expectedDefense: "Nonce set + audience/op binding + expiry",
    severityIfBroken: "high",
  },
  {
    id: "AT-STALE-01",
    invariant: "INV-09",
    title: "Stale tab resolves newer fence",
    adversary: "stale browser tab / BFCache",
    goal: "Clear active incident with outdated resolution epoch",
    preconditions: ["Two tabs; fence advanced in A"],
    steps: ["Tab B issues resolve with old epoch", "Attempt protected op"],
    expectedDefense: "rejectStaleResolution; BroadcastChannel hint-only",
    severityIfBroken: "high",
  },
  {
    id: "AT-BACKUP-01",
    invariant: "INV-23",
    title: "Removal path traversal to foreign vault material",
    adversary: "malicious policy / local malware crafting manifest",
    goal: "Delete outside enumerated owned paths",
    preconditions: ["Local removal effect"],
    steps: ["Inject .. / encoded dots / wrong vault root into storagePath"],
    expectedDefense: "assertOwnedPath rejects traversal and foreign roots",
    severityIfBroken: "critical",
  },
  {
    id: "AT-BACKUP-02",
    invariant: "INV-24",
    title: "Historical snapshot rollback clears incident",
    adversary: "operator restoring old OPFS/backup",
    goal: "Silently undo active incident state",
    preconditions: ["Offline snapshot with old keys"],
    steps: ["Restore snapshot", "Unlock with historical root"],
    expectedDefense: "Documented exposure; never claim retroactive secrecy",
    severityIfBroken: "medium",
  },
  {
    id: "AT-ALERT-01",
    invariant: "INV-16",
    title: "Treat relay accept as human acknowledgement",
    adversary: "malicious relay",
    goal: "Mark emergency handled without human",
    preconditions: ["Alert outbox queued"],
    steps: ["Advance to human_acknowledged with relay authority"],
    expectedDefense: "authority_mismatch on non-human ack",
    severityIfBroken: "high",
  },
  {
    id: "AT-PARTIAL-01",
    invariant: "INV-17",
    title: "Destroy local vault when notify fails",
    adversary: "network adversary blocking alerts",
    goal: "Force auto-destruction on delivery failure",
    preconditions: ["Alert + removal profile"],
    steps: ["Fail outbox delivery", "Observe whether removal cascades"],
    expectedDefense: "Local protections remain; no destroy-on-notify-fail",
    severityIfBroken: "critical",
  },
  {
    id: "AT-CRYPTO-01",
    invariant: "INV-06",
    title: "PRF alone or code alone opens two-input envelope",
    adversary: "coercer with UV/PRF device but not code (or vice versa)",
    goal: "Open compartment key with one factor",
    preconditions: ["prf_and_code enrolled"],
    steps: ["Call openPrfAndCode with null code", "Call with null PRF"],
    expectedDefense: "Returns null unless both present",
    severityIfBroken: "critical",
  },
  {
    id: "AT-BYPASS-01",
    invariant: "INV-26",
    title: "Legacy shared-root project key as decoy compartment",
    adversary: "malicious settings / policy author",
    goal: "Claim decoy isolation while sharing production project key",
    preconditions: ["Shared-root forks exist"],
    steps: [
      "Compile decoy with non-independent compartment",
      "Switch project under fence",
    ],
    expectedDefense:
      "independent_keys_required; assertCompartmentSwitchAllowed",
    severityIfBroken: "critical",
  },
] as const;

export function attackTreeById(id: string): AttackNode | undefined {
  return DURESS_ATTACK_TREES.find((n) => n.id === id);
}
