/** Host-only jar; an exact-host Domain attribute never broadens its scope. */
type Cookie = {
  name: string;
  value: string;
  host: string;
  path: string;
  secure: boolean;
  expires: number | null;
};

function defaultPath(pathname: string): string {
  const last = pathname.lastIndexOf("/");
  return last <= 0 ? "/" : pathname.slice(0, last);
}

function pathMatches(request: string, cookie: string): boolean {
  return (
    request === cookie ||
    (request.startsWith(cookie) &&
      (cookie.endsWith("/") || request[cookie.length] === "/"))
  );
}

type CookieAttributes = {
  path: string;
  secure: boolean;
  expires: number | null;
  maxAge: number | null;
  hasDomain: boolean;
  domainMatches: boolean;
};

function applyAttribute(
  state: CookieAttributes,
  url: URL,
  attribute: string,
): void {
  const [rawName, ...rest] = attribute.trim().split("=");
  const key = (rawName ?? "").toLowerCase();
  const value = rest.join("=").trim();
  if (key === "domain") {
    state.hasDomain = true;
    if (value.replace(/^\./u, "").toLowerCase() !== url.hostname.toLowerCase())
      state.domainMatches = false;
  }
  if (key === "secure") state.secure = true;
  if (key === "path" && value.startsWith("/")) state.path = value;
  if (key === "expires") {
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) state.expires = parsed;
  }
  if (key === "max-age" && /^-?\d+$/u.test(value)) state.maxAge = Number(value);
}

function cookiePair(
  pair: string | undefined,
): { name: string; value: string } | null {
  if (!pair) return null;
  const eq = pair.indexOf("=");
  if (eq <= 0) return null;
  const name = pair.slice(0, eq).trim();
  const value = pair.slice(eq + 1).trim();
  if (
    !/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/u.test(name) ||
    [...value].some(
      (char) =>
        char.charCodeAt(0) <= 32 ||
        char.charCodeAt(0) === 127 ||
        char === ";" ||
        char === ",",
    )
  )
    return null;
  return { name, value };
}

function validAttributes(
  name: string,
  url: URL,
  state: CookieAttributes,
): boolean {
  return !(
    !state.domainMatches ||
    (state.secure && url.protocol !== "https:") ||
    (name.startsWith("__Secure-") && !state.secure) ||
    (name.startsWith("__Host-") &&
      (!state.secure || state.path !== "/" || state.hasDomain))
  );
}

function parseCookie(url: URL, line: string): Cookie | null {
  const [pair, ...attributes] = line.split(";");
  const parsed = cookiePair(pair);
  if (!parsed) return null;
  const state: CookieAttributes = {
    path: defaultPath(url.pathname),
    secure: false,
    expires: null,
    maxAge: null,
    hasDomain: false,
    domainMatches: true,
  };
  for (const attribute of attributes) applyAttribute(state, url, attribute);
  if (!validAttributes(parsed.name, url, state)) return null;
  const expires =
    state.maxAge === null
      ? state.expires
      : state.maxAge <= 0
        ? 0
        : Date.now() + state.maxAge * 1000;
  return {
    name: parsed.name,
    value: parsed.value,
    host: url.hostname,
    path: state.path,
    secure: state.secure,
    expires,
  };
}

export class CookieJar {
  private readonly cookies: Cookie[] = [];

  store(url: URL, headers: Headers): void {
    for (const line of headers.getSetCookie?.() ?? []) {
      const cookie = parseCookie(url, line);
      if (!cookie) continue;
      const index = this.cookies.findIndex(
        (c) =>
          c.host === url.hostname &&
          c.path === cookie.path &&
          c.name === cookie.name,
      );
      if (index >= 0) this.cookies.splice(index, 1);
      if (cookie.expires === null || cookie.expires > Date.now())
        this.cookies.push(cookie);
    }
  }

  header(url: URL): string {
    return this.cookies
      .filter(
        (c) =>
          c.host === url.hostname &&
          (!c.secure || url.protocol === "https:") &&
          (c.expires === null || c.expires > Date.now()) &&
          pathMatches(url.pathname, c.path),
      )
      .sort((a, b) => b.path.length - a.path.length)
      .map((c) => `${c.name}=${c.value}`)
      .join("; ");
  }
}
