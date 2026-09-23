import type { BoundaryValue } from "@opensesame/os-domain";
import { browsableUrl } from "./model.js";

export type UriMatch =
  | "domain"
  | "host"
  | "exact"
  | "never"
  | "wildcard"
  | "regex";
export type LoginUri = {
  /** Stable across edits so rows retain identity. */
  id: string;
  uri: string;
  match: UriMatch;
};

export function loginWebsiteLink(uri: LoginUri): string | null {
  return uri.match === "wildcard" || uri.match === "regex"
    ? null
    : browsableUrl(uri.uri);
}

export type PatternResult =
  | "match"
  | "no-match"
  | "invalid"
  | "timeout"
  | "unavailable";

/** Match a whole HTTP(S) hostname, never URL paths, credentials or query text. */
export async function testWebsitePattern(
  rule: Pick<LoginUri, "uri" | "match">,
  website: string,
): Promise<PatternResult> {
  let hostname: string;
  try {
    const url = new URL(
      website.includes("://") ? website : `https://${website}`,
    );
    if (
      !["https:", "http:"].includes(url.protocol) ||
      url.username ||
      url.password
    )
      return "invalid";
    hostname = url.hostname.replace(/\.$/, "");
  } catch {
    return "invalid";
  }
  if (rule.uri.length > 256 || !rule.uri.trim() || hostname.length > 253)
    return "invalid";
  if (rule.match === "wildcard" && rule.uri.trim() === "*") return "match";
  return new Promise((resolve) => {
    let worker: Worker;
    try {
      worker = new Worker(
        new URL("./website-pattern.worker.ts", import.meta.url),
        { type: "module" },
      );
    } catch {
      resolve("unavailable");
      return;
    }
    const finish = (result: PatternResult) => {
      clearTimeout(timer);
      worker.terminate();
      resolve(result);
    };
    const timer = setTimeout(() => finish("timeout"), 1000);
    worker.onerror = () => finish("unavailable");
    worker.onmessage = (event: MessageEvent<BoundaryValue>) =>
      finish(
        event.data === "match" || event.data === "no-match"
          ? event.data
          : "invalid",
      );
    worker.postMessage({
      pattern: rule.uri.trim(),
      kind: rule.match,
      hostname,
    });
  });
}

export async function validateWebsitePatterns(uris: LoginUri[]): Promise<void> {
  for (const uri of uris) {
    if (uri.match !== "wildcard" && uri.match !== "regex") continue;
    const result = await testWebsitePattern(uri, "https://validation.invalid");
    if (result !== "match" && result !== "no-match") {
      throw new Error(
        `Website pattern could not be validated (${result}). Check the pattern and try again.`,
      );
    }
  }
}
