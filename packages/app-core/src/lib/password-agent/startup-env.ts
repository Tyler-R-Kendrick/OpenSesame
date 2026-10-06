/** Provider credentials must never reach interpreter startup hooks. */
import { passwordAgentPolicy } from "./policy.js";
const reserved = new Set(passwordAgentPolicy.credentialStartupEnvKeys);
const quotes = new Set(['"', "'", "`"]);
export function assertSafeRunName(name: string): void {
  if (reserved.has(name.toUpperCase()))
    throw new Error(
      "Interpreter startup environment variables cannot be injected into credential-bearing processes.",
    );
}
function hasClosingQuote(value: string, quote: string): boolean {
  // Treat even an escaped delimiter as a close: provider dotenv dialects differ,
  // so ambiguity must never hide a subsequent startup-variable assignment.
  return value.includes(quote);
}
export function validateRunTemplate(content: string): void {
  let multilineQuote: string | undefined;
  for (const literal of content.split(/\r\n|\r|\n/)) {
    if (multilineQuote) {
      if (hasClosingQuote(literal, multilineQuote)) multilineQuote = undefined;
      continue;
    }
    const line = literal.trim();
    if (!line || line.startsWith("#")) continue;
    const match =
      /^(?:export\s+)?["'`]?([A-Za-z_][A-Za-z0-9_.-]*)["'`]?\s*(?:=|:\s+)/.exec(
        line,
      );
    if (!match) continue;
    assertSafeRunName(match[1] ?? "");
    const value = line.slice(match[0].length).trim();
    const quote = value[0];
    if (quote && quotes.has(quote) && !hasClosingQuote(value.slice(1), quote)) {
      if (quote === "`")
        throw new Error(
          "Unsupported multiline backtick syntax cannot safely screen interpreter startup variables.",
        );
      multilineQuote = quote;
    }
  }
}
