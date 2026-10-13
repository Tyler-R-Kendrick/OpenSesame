import { writeCliAppIntegrationBearer } from "@opensesame/app-core/lib/cli-app-integration/bearer-session.js";
import {
  isTailnetOrLoopback,
  normalizeTailnetBase,
} from "@opensesame/app-core/lib/urls.js";

const PREFIX = "opensesame-cli-app:v1:";
const SECRET = /^[A-Za-z0-9_-]{43}$/;

function daemonBase(url: string): string | null {
  const base = normalizeTailnetBase(url);
  return base && isTailnetOrLoopback(base) ? base : null;
}

function isPairingOriginValid(origin: string): boolean {
  try {
    const o = new URL(origin);
    if (o.origin !== origin || o.username || o.password) return false;
    if (o.protocol === "https:") {
      if (o.hostname.endsWith(".")) return false;
    } else if (
      o.protocol !== "http:" ||
      o.hostname !== "localhost" ||
      o.port === ""
    ) {
      return false;
    }
  } catch {
    return false;
  }
  return true;
}

function parseWire(wire: Record<string, unknown>) {
  const code = wire.code;
  const origin = wire.origin;
  const url = wire.url;
  const label = wire.label;
  if (typeof code !== "string" || !SECRET.test(code)) return null;
  if (typeof origin !== "string" || !isPairingOriginValid(origin)) return null;
  if (typeof url !== "string" || !daemonBase(url)) return null;
  if (typeof label !== "string") return null;
  return { code, origin, url, label };
}

export function parseCliPairingCode(raw: string) {
  const trimmed = raw.trim();
  if (!trimmed.startsWith(PREFIX)) return null;
  try {
    const b64 = trimmed
      .slice(PREFIX.length)
      .replaceAll("-", "+")
      .replaceAll("_", "/");
    const pad = b64.length % 4 === 0 ? "" : "=".repeat(4 - (b64.length % 4));
    const wire = JSON.parse(atob(b64 + pad));
    if (!wire || typeof wire !== "object") return null;
    return parseWire(wire);
  } catch {
    return null;
  }
}

async function exchangePairing(
  parsed: { code: string; origin: string; url: string },
  pageBinding: string,
) {
  const base = daemonBase(parsed.url);
  if (!base) return false;
  const body = JSON.stringify({ code: parsed.code, pageBinding });
  const post = (path: string) =>
    fetch(`${base}${path}`, {
      method: "POST",
      credentials: "omit",
      headers: { "content-type": "application/json", Origin: parsed.origin },
      body,
    });
  if ((await post("/v1/cli/app-integration/pairing/confirm")).status !== 204)
    return false;
  const exchange = await post("/v1/cli/app-integration/pairing");
  if (exchange.status !== 201) return false;
  const json = await exchange.json();
  if (!json || typeof json !== "object") return false;
  const token = Reflect.get(json, "token");
  if (typeof token !== "string" || !SECRET.test(token)) return false;
  writeCliAppIntegrationBearer(token);
  return true;
}

export async function pairCliWithDaemon(parsed: {
  code: string;
  origin: string;
  url: string;
}): Promise<boolean> {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  const pageBinding = btoa(String.fromCharCode(...bytes))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");
  if (!SECRET.test(pageBinding)) return false;
  return exchangePairing(parsed, pageBinding);
}
