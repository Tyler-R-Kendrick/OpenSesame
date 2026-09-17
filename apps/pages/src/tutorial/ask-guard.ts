import { refuseUntrustedProposal } from "../lib/configuration/proposals.js";

export type AskGate =
  | { kind: "skip" }
  | { kind: "refused"; message: string }
  | { kind: "ok"; text: string };

export function gateSupportAsk(question: string, thinking: boolean): AskGate {
  const text = question.trim();
  if (text.length === 0 || thinking) return { kind: "skip" };
  const refused = refuseUntrustedProposal(text);
  if (!refused.ok) return { kind: "refused", message: refused.message };
  return { kind: "ok", text };
}
