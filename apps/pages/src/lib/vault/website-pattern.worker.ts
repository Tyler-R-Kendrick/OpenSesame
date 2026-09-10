/** Untrusted regexes execute only in this disposable, time-bounded worker. */
export {};
self.onmessage = (
  event: MessageEvent<{ pattern: string; kind: string; hostname: string }>,
) => {
  const { pattern, kind, hostname } = event.data;
  if (pattern.length > 256 || hostname.length > 253 || !pattern.trim()) {
    self.postMessage("invalid");
    return;
  }
  try {
    if (kind !== "wildcard" && kind !== "regex")
      throw new Error("Unknown mode");
    if (kind === "wildcard" && !/^[a-z0-9.*?-]+$/i.test(pattern)) {
      throw new Error("Not a domain wildcard");
    }
    const source =
      kind === "regex"
        ? pattern
        : pattern
            .replace(/[.]/g, "\\.")
            .replace(/\*/g, ".*")
            .replace(/\?/g, ".");
    const expression = new RegExp(`^(?:${source})$`, "i");
    self.postMessage(expression.test(hostname) ? "match" : "no-match");
  } catch {
    self.postMessage("invalid");
  }
};
