import {
  digestAgentClaimToken,
  looksLikeAgentAccessToken,
  looksLikeAgentClaimToken,
  parseAgentClaimAttemptToken,
  parseAgentClaimToken,
} from "@opensesame/os-domain";
import { FuzzedDataProvider } from "./provider.js";

export function fuzz(data: Buffer): void {
  const p = new FuzzedDataProvider(data);
  const presented = p.consumeRemainingAsString();
  const parsed = parseAgentClaimToken(presented);
  if (parsed && !looksLikeAgentClaimToken(presented)) {
    throw new Error("parsed a claim token the prefix check rejected");
  }
  if (
    looksLikeAgentClaimToken(presented) &&
    looksLikeAgentAccessToken(presented)
  ) {
    throw new Error("one bearer matched two AgentAuth prefixes");
  }
  if (
    parseAgentClaimToken(presented) &&
    parseAgentClaimAttemptToken(presented)
  ) {
    throw new Error("one bearer parsed as both claim and claim-attempt");
  }
  if (presented.startsWith("osc_clm_") || presented.startsWith("pst_")) {
    if (digestAgentClaimToken("pepper", presented) !== null) {
      throw new Error("product bearer digested as an agent claim token");
    }
  }
}
