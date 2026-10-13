import {
  readCliAppIntegrationBearer,
  writeCliAppIntegrationBearer,
} from "@opensesame/app-core/lib/cli-app-integration/bearer-session.js";
import {
  isTailnetOrLoopback,
  normalizeTailnetBase,
} from "@opensesame/app-core/lib/urls.js";
import { type FormEvent, useCallback, useState } from "react";
import { IconConnection } from "../../components/Icons.js";
import { StatusMark } from "../../components/StatusMark.js";

const fieldId = "cli-authorize-pairing-code";
const PAIR = "Pair with the daemon";
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

function parseCode(raw: string) {
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
    const { code, origin, url, label } = wire;
    if (
      typeof code !== "string" ||
      !SECRET.test(code) ||
      typeof origin !== "string" ||
      typeof url !== "string" ||
      !daemonBase(url) ||
      typeof label !== "string"
    ) {
      return null;
    }
    if (!isPairingOriginValid(origin)) return null;
    return { code, origin, url, label };
  } catch {
    return null;
  }
}

async function pair(parsed: {
  code: string;
  origin: string;
  url: string;
}) {
  const base = daemonBase(parsed.url);
  if (!base) return false;
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  const pageBinding = btoa(String.fromCharCode(...bytes))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");
  if (!SECRET.test(pageBinding)) return false;
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

export function CliAuthorizePairingForm({
  onPaired,
}: {
  onPaired: () => void;
}) {
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [mark, setMark] = useState<string | null>(null);
  const paired = readCliAppIntegrationBearer() !== null;
  const refresh = useCallback(() => onPaired(), [onPaired]);

  async function onPair(event: FormEvent) {
    event.preventDefault();
    const raw = code.trim();
    if (!raw || busy) return;
    const parsed = parseCode(raw);
    if (!parsed) {
      setMark("Not a CLI pairing code.");
      return;
    }
    setBusy(true);
    setMark(null);
    const ok = await pair(parsed);
    setBusy(false);
    if (!ok) {
      setMark("The daemon would not take that code.");
      return;
    }
    setCode("");
    refresh();
  }

  if (paired) {
    return <StatusMark tone="ok" label="Paired for CLI on this browser." />;
  }

  return (
    <>
      <form className="plugin-tile__pair" onSubmit={onPair}>
        <label htmlFor={fieldId}>Pairing code</label>
        <div className="field-inline">
          <input
            id={fieldId}
            type="text"
            value={code}
            placeholder="opensesame-cli-app:v1:…"
            autoComplete="off"
            autoCapitalize="off"
            spellCheck={false}
            readOnly={busy}
            onChange={(event) => setCode(event.target.value)}
          />
          {code.trim().length > 0 ? (
            <button
              type="submit"
              className="icon-btn"
              aria-busy={busy || undefined}
              aria-label={PAIR}
              title={PAIR}
            >
              <IconConnection size={16} />
            </button>
          ) : null}
        </div>
      </form>
      {mark ? (
        <output aria-live="polite">
          <StatusMark tone="err" label={mark} />
        </output>
      ) : null}
    </>
  );
}
