/** Render the compiled setup guide's inline Markdown with explicit official-link authority. */
import type { ReactNode } from "react";
import { nativePublicUrl } from "./native-connector-ui-values.js";

const TOKEN = /\[([^\]\n]+)\]\(([^)\s]+)\)|\*\*([^*\n]+)\*\*|`([^`\n]+)`/g;

/** Status labels retain readable wording without Markdown control characters or raw link targets. */
export function nativeProviderInstructionText(text: string) {
  let readable = "";
  let cursor = 0;
  for (const match of text.matchAll(TOKEN)) {
    readable += text.slice(cursor, match.index);
    readable += match[1] ?? match[3] ?? match[4] ?? "";
    cursor = match.index + match[0].length;
  }
  return readable + text.slice(cursor);
}

function providerInstructionParts(text: string, origins: readonly string[]) {
  const parts: ReactNode[] = [];
  let cursor = 0;
  for (const match of text.matchAll(TOKEN)) {
    parts.push(text.slice(cursor, match.index));
    if (match[1] !== undefined) {
      const url = match[2] ? nativePublicUrl(match[2], origins) : null;
      parts.push(
        url ? (
          <a
            key={match.index}
            href={url}
            target="_blank"
            rel="noreferrer noopener"
          >
            {match[1]}
          </a>
        ) : (
          match[1]
        ),
      );
    } else if (match[3] !== undefined) {
      parts.push(<strong key={match.index}>{match[3]}</strong>);
    } else {
      parts.push(<code key={match.index}>{match[4]}</code>);
    }
    cursor = match.index + match[0].length;
  }
  parts.push(text.slice(cursor));
  return parts;
}

export function NativeProviderInstructions({
  text,
  origins = [],
}: {
  text: string;
  origins?: readonly string[];
}) {
  return <p>{providerInstructionParts(text, origins)}</p>;
}
