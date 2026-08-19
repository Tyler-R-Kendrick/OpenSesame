import { defineConfig } from "deepsec/config";
import { generatedMatchersPlugin } from "./generated-matchers.js";

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
        "apps/gateway/",
        "apps/control-plane/",
        "apps/daemon/",
        "apps/pages/src/",
        "apps/worker/",
        "crates/authz/",
        "crates/authn/",
        "crates/connection-broker/",
        "crates/human-vault/",
        "crates/sealed-store/",
        "crates/task-bus/",
        "crates/claims/",
        "crates/proof/",
        "packages/oauth-provider/",
        "packages/auth-upstream/",
        "packages/sdk-browser/",
        "packages/api-client/",
      ],
      promptAppend:
        "OpenSesame: Identity API and Host API must stay separate (no BFF). " +
        "Never accept email-join for NATS callout. Outbox is SoT; JetStream is wake-only. " +
        "Flag any path that reveals secrets to agents or grants system bus subjects.",
    },
  ],
  plugins: [generatedMatchersPlugin],
});
