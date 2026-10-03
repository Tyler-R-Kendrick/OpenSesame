// Who the daemon's fill routes admit (`crates/daemon/src/fill/caller.rs`,
// `pairing.rs`), in the daemon's own order:
//
//   loopback          `Host` is 127.0.0.1 / localhost / [::1]; nothing forwarded
//   extension origin  `Origin: chrome-extension://<32 letters a-p>`
//   token             Bearer, 43-128 URL-safe characters
//   pairing           the token recorded for exactly that origin
import { createHash, randomInt, timingSafeEqual } from "node:crypto";

const CODE_ALPHABET = "ABCDEFGHJKMNPQRSTVWXYZ23456789";
const FORWARDING = [
  "forwarded",
  "x-forwarded-for",
  "x-forwarded-host",
  "x-forwarded-proto",
  "x-real-ip",
];
const LOOPBACK_HOST = /^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/;
const EXTENSION_ORIGIN = /^chrome-extension:\/\/[a-p]{32}$/;
const TOKEN = /^[A-Za-z0-9_-]{43,128}$/;

const digest = (token) => createHash("sha256").update(token).digest();
const sameToken = (a, b) => timingSafeEqual(digest(a), digest(b));

/** A refusal or an answer, as the daemon's routes write them. */
export function reply(res, status, body) {
  const text = body === undefined ? "" : JSON.stringify(body);
  const headers = { "cache-control": "no-store" };
  if (text) headers["content-type"] = "application/json";
  res.writeHead(status, headers);
  res.end(text);
}

export const refuse = (res, status, error) => reply(res, status, { error });

/** The caller off the request, or null after writing the refusal. */
function callerOf(req, res) {
  const forwarded = FORWARDING.some((name) => name in req.headers);
  if (forwarded || !LOOPBACK_HOST.test(req.headers.host ?? "")) {
    refuse(res, 403, "loopback_only");
    return null;
  }
  const origin = req.headers.origin ?? "";
  if (!EXTENSION_ORIGIN.test(origin)) {
    refuse(res, 403, "extension_origin_required");
    return null;
  }
  const token = /^Bearer (.+)$/.exec(req.headers.authorization ?? "")?.[1];
  if (!token || !TOKEN.test(token)) {
    refuse(res, 401, "pairing_token_required");
    return null;
  }
  return { origin, token };
}

export function createAdmission() {
  const paired = new Map(); // origin -> token
  const pending = new Map(); // origin -> { token, code }

  return {
    /** A caller whose token was recorded for its origin, or null. */
    pairedCaller(req, res) {
      const who = callerOf(req, res);
      if (!who) return null;
      const token = paired.get(who.origin);
      if (token === undefined || !sameToken(token, who.token)) {
        refuse(res, 401, "not_paired");
        return null;
      }
      return who;
    },

    /** `POST /v1/fill/pair`: open, or re-read, this extension's request. */
    pair(req, res) {
      const who = callerOf(req, res);
      if (!who) return;
      if (paired.get(who.origin) === who.token) {
        return reply(res, 200, { state: "paired" });
      }
      const open = pending.get(who.origin);
      if (open?.token === who.token) {
        return reply(res, 202, { state: "pending", code: open.code });
      }
      const code = Array.from(
        { length: 8 },
        () => CODE_ALPHABET[randomInt(CODE_ALPHABET.length)],
      ).join("");
      pending.set(who.origin, { token: who.token, code });
      reply(res, 202, { state: "pending", code });
    },

    /** The operator's approval of a code shown in the popup. */
    approve(code) {
      const wanted = code.replace(/[- ]/g, "").toUpperCase();
      for (const [origin, open] of pending) {
        if (open.code === wanted) {
          paired.set(origin, open.token);
          pending.delete(origin);
          return origin;
        }
      }
      throw new Error("no such pairing code");
    },

    isPaired: (origin) => paired.has(origin),
  };
}
