/** Parse NDJSON / JSON agent CLI stdout into plain text for deepsec parsers. */

function collectTextFromParsedObject(obj: Record<string, unknown>): string[] {
  const texts: string[] = [];
  if (typeof obj.result === "string") texts.push(obj.result);
  if (typeof obj.text === "string") texts.push(obj.text);
  if (typeof obj.message === "string" && obj.type !== "error")
    texts.push(obj.message);
  const content = obj.content;
  if (!Array.isArray(content)) return texts;
  for (const block of content) {
    if (
      block &&
      typeof block === "object" &&
      typeof (block as { text?: string }).text === "string"
    ) {
      texts.push((block as { text: string }).text);
    }
  }
  return texts;
}

function parseAgentStdoutLine(line: string, authHint?: string): string[] {
  try {
    const obj = JSON.parse(line) as Record<string, unknown>;
    if (obj.type === "error" && typeof obj.message === "string") {
      throw new Error(obj.message);
    }
    return collectTextFromParsedObject(obj);
  } catch (e) {
    if (authHint && e instanceof Error && e.message.includes(authHint)) throw e;
    return [];
  }
}

export function extractTextFromAgentStdout(
  stdout: string,
  authHint?: string,
): string {
  const trimmed = stdout.trim();
  if (!trimmed) return "";
  const lines = trimmed.split("\n").filter((l) => l.trim());
  const texts: string[] = [];
  for (const line of lines) {
    texts.push(...parseAgentStdoutLine(line, authHint));
  }
  if (texts.length > 0) return texts.join("\n");
  try {
    const whole = JSON.parse(trimmed) as Record<string, unknown>;
    if (typeof whole.result === "string") return whole.result;
    if (typeof whole.text === "string") return whole.text;
  } catch {
    // fall through
  }
  return trimmed;
}
