import type { BoatAgentAuth, BoatClaimMaterials } from "./boat-auth.js";
import type { BoatClient } from "./boat-client.js";

/**
 * Registration state that must survive the claim ceremony across
 * processes. It carries credentials (a claim token and identity
 * assertion), so hosts must protect it — never in a config file a
 * user might share. Access tokens are deliberately not persisted: the
 * assertion re-exchanges for a fresh one.
 */
export interface BoatProviderState {
  claimToken?: string;
  identityAssertion?: string;
  claimMaterials?: BoatClaimMaterials;
  claimIssuedAt?: number;
}

export interface BoatProviderOptions {
  /** Prebuilt clients (tests); otherwise built from options/environment. */
  client?: BoatClient;
  auth?: BoatAgentAuth;
  origin?: string;
  fetchImpl?: typeof fetch;
  /** Existing Boat API key; skips agent registration entirely. */
  apiToken?: string;
  /** Identity assertion from a prior registration (rotates to a token). */
  identityAssertion?: string;
  /** Claim token from a prior registration, to resume a pending claim. */
  claimToken?: string;
  /** Persisted registration state from a previous process. */
  state?: BoatProviderState;
  /** Called whenever registration state changes, to persist it securely. */
  onStateChange?: (state: BoatProviderState) => void | Promise<void>;
  /** The user's email, for the claim ceremony (`service_auth`). */
  claimEmail?: string;
  /**
   * Shell command that starts the relay agent inside the sandbox. When
   * omitted, the zero-provision bootstrap from `boat-agent.ts` clones
   * the public repository and runs the agent entry; set this (or
   * `BOAT_RELAY_AGENT_COMMAND`) to use a saved snapshot instead. The
   * command reads the `BOAT_AGENT_ENV` variables; see `boat-agent.ts`.
   */
  agentCommand?: string;
  /** Full commit SHA the bootstrap checks out (default: pinned reviewed commit). */
  agentRepoRef?: string;
  /** Saved snapshot to create sandboxes from. */
  fromSnapshot?: string;
  /** Stop (archive) instead of permanently deleting on close. */
  keepSandbox?: boolean;
  readyTimeoutMs?: number;
  agentReadyTimeoutMs?: number;
  /** Maximum time to wait for the relay to close before deleting the sandbox. */
  relayCloseTimeoutMs?: number;
  pollIntervalMs?: number;
}
