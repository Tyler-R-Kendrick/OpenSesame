/** SOPS cloud locator checks. Live calls stay outside this module. */

export function assertSopsHttpsEndpoint(raw: string): void {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("malformed provider endpoint");
  }
  if (url.protocol !== "https:")
    throw new Error("provider endpoint must be https");
  if (url.username !== "" || url.password !== "") {
    throw new Error("provider endpoint has userinfo");
  }
  const host = url.hostname.toLowerCase();
  if (
    host === "localhost" ||
    host === "metadata.google.internal" ||
    host === "169.254.169.254" ||
    host.endsWith(".local")
  ) {
    throw new Error("provider endpoint is not public");
  }
  if (isPrivateAddress(host))
    throw new Error("provider endpoint is not public");
}

function isPrivateAddress(host: string): boolean {
  const parts = host.split(".");
  if (parts.length !== 4) return false;
  const numbers = parts.map((part) => Number(part));
  if (
    numbers.some((part) => !Number.isInteger(part) || part < 0 || part > 255)
  ) {
    return false;
  }
  const [a, b] = numbers;
  if (a === undefined || b === undefined) return false;
  if (a === 10 || a === 127 || a === 0) return true;
  if (a === 169 && b === 254) return true;
  if (a === 192 && b === 168) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  return false;
}

/** Full canonical key identity. Prefix and suffix similarity do not match. */
export function awsKeysMatch(expected: string, returned: string): boolean {
  return expected.length > 0 && expected === returned;
}
