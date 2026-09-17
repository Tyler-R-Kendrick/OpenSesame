export type AskGate = { kind: "skip" } | { kind: "ok"; text: string };

/** Empty and in-flight asks are skipped; support may name mutations in questions. */
export function gateSupportAsk(question: string, thinking: boolean): AskGate {
  const text = question.trim();
  if (text.length === 0 || thinking) return { kind: "skip" };
  return { kind: "ok", text };
}
