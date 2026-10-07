import { defineConfig } from "deepsec/config";
import { generatedMatchersPlugin } from "./generated-matchers.js";
import { grokAgentPlugin } from "./grok-agent-plugin.js";

/**
 * Default AI route (unchanged for `pnpm audit:deepsec` / DEEPSEC_PROCESS=1):
 * Pi + Vercel AI Gateway. Grok Build scans use `--agent grok` (see
 * `scripts/audit/deepsec-grok-scan.sh`) and ignore gateway credentials.
 */
export default defineConfig({
  defaultThinkingLevel: "medium", // <deepsec:default-thinking-level>
  defaultModel: "zai/glm-5.2", // <deepsec:default-model>
  ai: { mode: "gateway", provider: "vercel" }, // <deepsec:model-route>
  defaultAgent: "pi", // <deepsec:default-agent>
  projects: [
    {
      id: "opensesame",
      root: "..",
      priorityPaths: [
        // Core (host/client/vault kernel)
        "crates/core/",
        "crates/client-core/",
        "crates/host-core/",
        "packages/app-core/",
        "packages/vault-core/",
        // PWA
        "apps/pages/",
        // CLIs
        "apps/cli/",
        "packages/cli/",
        // High-risk surfaces (retained from initial setup)
        "crates/gateway/",
        "crates/human-vault/",
        "crates/sealed-store/",
        "packages/control-plane/",
      ],
      promptAppend:
        "OpenSesame: Identity API and Host API must stay separate (no BFF). " +
        "Never accept email-join for NATS callout. Outbox is SoT; JetStream is wake-only. " +
        "Flag any path that reveals secrets to agents, drop/claim or live-session flows in apps/pages, " +
        "auth/session handling, crypto and at-rest storage, and CLI paths that could print secrets to logs.",
    },
  ],
  plugins: [generatedMatchersPlugin, grokAgentPlugin],
});
