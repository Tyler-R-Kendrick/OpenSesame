import type { GuideGoalDescriptor } from "./goal-types.js";

export const HEALTH_REVIEW_GOAL = {
  id: "vault.health.review",
  title: "Review password health",
  routes: [],
  capabilities: ["vault.security-checks"],
  guide: [
    "guide/1",
    'goal "vault.health.review"',
    'say "Health is computed here, over the decrypted collection. No password, and no hash of one, leaves this device."',
    'navigate "/vault/health"',
    'wait route "/vault/health" timeout=15000',
    'annotate "vault.health.summary" "The verdict: how many passwords were reviewed, and how many are weak, reused or aging." side=bottom',
    'focus "vault.health.findings" "Anything flagged is listed here, each with why it was flagged and a way to open that item for editing." side=top',
    "end",
  ].join("\n"),
} satisfies GuideGoalDescriptor;
