import { AiConnectionError } from "./types.js";

export function aiConnectionBase(value: string): URL {
  let base: URL;
  try {
    base = new URL(value.trim());
  } catch {
    throw new AiConnectionError(
      "configuration",
      "Enter a complete AI API base URL.",
    );
  }
  const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(base.hostname);
  if (
    !(base.protocol === "https:" || (base.protocol === "http:" && loopback)) ||
    base.username ||
    base.password ||
    base.search ||
    base.hash ||
    /[\\\r\n]/.test(value) ||
    /%2e|%2f|%5c/i.test(value)
  )
    throw new AiConnectionError(
      "configuration",
      "Use HTTPS, or loopback HTTP, without URL credentials, query or fragment.",
    );
  base.pathname = `${base.pathname.replace(/\/+$/, "")}/`;
  return base;
}
