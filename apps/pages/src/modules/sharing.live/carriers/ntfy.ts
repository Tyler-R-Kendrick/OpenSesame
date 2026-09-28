/**
 * ntfy as a carrier (https://ntfy.sh, or one's own behind Cloudflare Tunnel,
 * Pangolin or `tailscale serve`): publish is a POST to `<server>/<topic>`,
 * listening is the topic's JSON stream, read as it arrives and opened again
 * if the server drops it — from the last message heard (`since=`), so a code
 * posted while it was reconnecting is not lost. A token or a user and
 * password go in the Authorization header, never in the URL.
 */

import type { Carrier } from "@opensesame/app-core/lib/live/rendezvous.js";
import type { CarrierSpec } from "@opensesame/app-core/lib/live/transport.js";
import {
  type BoundaryValue,
  isJsonObject,
  isString,
} from "@opensesame/os-domain";

const RETRY_MS = 3000;
const LINE_MAX = 16 * 1024;

function authorization(spec: CarrierSpec): Headers {
  const headers = new Headers();
  if (spec.token) headers.set("Authorization", `Bearer ${spec.token}`);
  else if (spec.username && spec.password)
    headers.set(
      "Authorization",
      `Basic ${btoa(`${spec.username}:${spec.password}`)}`,
    );
  return headers;
}

type Heard = { id: string; message: string };

function messageOf(line: string): Heard | null {
  if (line.length > LINE_MAX) return null;
  try {
    const value: BoundaryValue = JSON.parse(line);
    if (!isJsonObject(value) || value.event !== "message") return null;
    const { id, message } = value;
    return isString(id) && isString(message) ? { id, message } : null;
  } catch {
    return null;
  }
}

/** Read one JSON stream to its end, handing on each message. */
async function drain(
  response: Response,
  onHeard: (heard: Heard) => void,
): Promise<void> {
  const reader = response.body
    ?.pipeThrough(new TextDecoderStream())
    .getReader();
  if (!reader) return;
  let buffered = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return;
    buffered += value;
    const lines = buffered.split("\n");
    buffered = lines.pop() ?? "";
    if (buffered.length > LINE_MAX) buffered = "";
    for (const line of lines) {
      const heard = messageOf(line);
      if (heard !== null) onHeard(heard);
    }
  }
}

function withType(headers: Headers): Headers {
  const out = new Headers(headers);
  out.set("Content-Type", "text/plain");
  return out;
}

export async function ntfyCarrier(
  spec: CarrierSpec,
  topic: string,
): Promise<Carrier> {
  const base = spec.url.replace(/\/+$/, "");
  const headers = authorization(spec);
  const aborts = new Set<AbortController>();
  let closed = false;

  // One subscription proves the server is there before the session counts on it.
  const first = new AbortController();
  aborts.add(first);
  const opened = await fetch(`${base}/${topic}/json`, {
    headers,
    signal: first.signal,
    cache: "no-store",
  });
  if (!opened.ok) throw new Error(`ntfy_${opened.status}`);

  return {
    async post(text) {
      const response = await fetch(`${base}/${topic}`, {
        method: "POST",
        headers: withType(headers),
        body: text,
      });
      if (!response.ok) throw new Error(`ntfy_${response.status}`);
    },
    listen(onText) {
      let response: Response | null = opened;
      // Where to pick up from: the last message's id, else when we began.
      let since = String(Math.floor(Date.now() / 1000));
      void (async () => {
        while (!closed) {
          let failed = false;
          try {
            if (!response) {
              const again = new AbortController();
              aborts.add(again);
              response = await fetch(
                `${base}/${topic}/json?since=${encodeURIComponent(since)}`,
                { headers, signal: again.signal, cache: "no-store" },
              );
              if (!response.ok) throw new Error(`ntfy_${response.status}`);
            }
            await drain(response, (heard) => {
              since = heard.id;
              onText(heard.message);
            });
          } catch {
            failed = true;
          }
          response = null;
          // A stream the server ended is picked up again at once; a refusal
          // or a dropped connection waits first.
          if (!closed && failed)
            await new Promise((r) => setTimeout(r, RETRY_MS));
        }
      })();
      return () => {
        closed = true;
        for (const abort of aborts) abort.abort();
      };
    },
    close() {
      closed = true;
      for (const abort of aborts) abort.abort();
    },
  };
}
