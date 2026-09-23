/**
 * Hosted identity summary — whether an Identity session is active and, when
 * it is, the principal with its linked identities. Owned by
 * `identity.federation` (the Identity-API session); tokens never leave.
 */

import { currentSession, fetchPrincipal } from "../lib/identity.js";
import type { PagesWebMcpTool } from "./tool-shared.js";

export const IDENTITY_READ_TOOL: PagesWebMcpTool = {
  name: "opensesame_identity_read",
  capabilityIds: ["identity.whoami", "identity.admin"],
  scope: "session",
  readOnly: true,
  description:
    "Read-only identity summary: whether a session is active and, when signed in, the principal with its linked identities. Never returns tokens.",
  inputSchema: {
    type: "object",
    properties: {},
    additionalProperties: false,
  },
  execute: async () => {
    const session = currentSession();
    if (!session) return { signedIn: false };
    const principal = await fetchPrincipal();
    return {
      signedIn: true,
      principal: {
        id: principal.id,
        state: principal.state,
        assurance: principal.assurance,
        createdAt: principal.createdAt,
        identities: principal.identities.map((identity) => ({
          kind: identity.kind,
          issuer: identity.issuer,
          displayHint: identity.displayHint ?? null,
          assurance: identity.assurance,
        })),
      },
    };
  },
};
