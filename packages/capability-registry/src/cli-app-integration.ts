import type { Capability } from "./index.js";

/** CLI ↔ app integration ceremonies (ADR 0186). */
export const cliAppIntegrationCapabilities: readonly Capability[] = [
  {
    id: "cli.app_integration.list",
    title: "List pending CLI app-integration requests",
    plane: "client_local",
    kind: "ceremony",
    surfaces: {
      cli: null,
      pwa: "route:/identity",
      mcp_host: null,
      mcp_client: null,
      webmcp: null,
    },
    excluded: {
      mcp_host: {
        reason:
          "CLI app-integration approval is bound to the human's browser session on loopback",
        adr: "0186-cli-app-integration-reveal.md",
      },
      mcp_client: {
        reason:
          "Agents cannot observe or approve terminal CLI integration on the person's device",
        adr: "0186-cli-app-integration-reveal.md",
      },
      webmcp: {
        reason:
          "Navigation may open Identity; CLI integration approval requires the human",
        adr: "0186-cli-app-integration-reveal.md",
      },
    },
  },
  {
    id: "cli.app_integration.respond",
    title: "Approve or deny CLI app-integration for this terminal",
    plane: "client_local",
    kind: "ceremony",
    surfaces: {
      cli: null,
      pwa: "route:/identity/authorize",
      mcp_host: null,
      mcp_client: null,
      webmcp: null,
    },
    excluded: {
      mcp_host: {
        reason:
          "CLI app-integration consent requires the human and a verified passkey or PIN",
        adr: "0186-cli-app-integration-reveal.md",
      },
      mcp_client: {
        reason:
          "Agents cannot approve their own terminal's vault reveal integration",
        adr: "0186-cli-app-integration-reveal.md",
      },
      webmcp: {
        reason:
          "Agents may navigate; they cannot authorize CLI plaintext reveal for a terminal",
        adr: "0186-cli-app-integration-reveal.md",
      },
    },
  },
];
