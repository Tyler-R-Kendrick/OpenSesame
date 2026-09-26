/**
 * The account factors' half of the stand-in Identity API (Settings ›
 * Security's *Your account* rows, ADR 0140 D10, plan step 11b), and the
 * verbs a capture needs to walk them.
 *
 * The stand-in answers the routes the Pages model calls, the way the
 * Identity API does: `GET /v1/mfa/factors` lists display-safe records only
 * (kind, an opaque `pk_…` or `totp` id, created); a passkey is registered
 * over creation options whose relying party is the Pages origin's host, so
 * the virtual authenticator `passkey` (capture-approval-steps.mjs) adds can
 * make it, and the register call is refused unless the browser's
 * `clientDataJSON` is a `webauthn.create` over the challenge it was given;
 * a TOTP seed is written at enroll, as the service does, and a code is
 * accepted only when it is RFC 6238's for that seed now.
 */

import { createHash, createHmac, randomBytes } from "node:crypto";

/** The stand-in's one TOTP seed, base32: 20 bytes, a fixed test value. */
const TOTP_SECRET = "JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP";

function base32Decode(text) {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let bits = "";
  for (const char of text.replace(/=+$/, "")) {
    bits += alphabet.indexOf(char).toString(2).padStart(5, "0");
  }
  const bytes = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) {
    bytes.push(Number.parseInt(bits.slice(i, i + 8), 2));
  }
  return Buffer.from(bytes);
}

/** RFC 6238, SHA-1, six digits, 30-second steps. */
export function totpNow(secret = TOTP_SECRET, at = Date.now()) {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(at / 30_000)));
  const mac = createHmac("sha1", base32Decode(secret)).update(counter).digest();
  const offset = mac[mac.length - 1] & 0x0f;
  const code = (mac.readUInt32BE(offset) & 0x7fffffff) % 1_000_000;
  return String(code).padStart(6, "0");
}

function bodyOf(request) {
  try {
    return JSON.parse(request.postData() ?? "{}");
  } catch {
    return {};
  }
}

/** One page's account: its factors and the challenge last handed out. */
export function factorState() {
  return { factors: [], challenge: null };
}

function registered(state, body) {
  const response = body.response;
  if (!response?.response?.attestationObject) return null;
  let client;
  try {
    client = JSON.parse(
      Buffer.from(response.response.clientDataJSON, "base64url").toString(),
    );
  } catch {
    return null;
  }
  if (client.type !== "webauthn.create" || client.challenge !== state.challenge)
    return null;
  state.challenge = null;
  const digest = createHash("sha256").update(response.id).digest("hex");
  return { id: `pk_${digest.slice(0, 32)}`, kind: "passkey" };
}

/**
 * Answer an account-factor route at `at` (`METHOD /path`), or `null`. The
 * relying party id is the Pages origin's host.
 */
export function answerFactors(state, at, request, pagesOrigin) {
  const body = bodyOf(request);
  if (at === "GET /v1/mfa/factors") {
    return [
      200,
      { ok: true, factors: state.factors, enrollable: ["passkey", "totp"] },
    ];
  }
  if (at === "POST /v1/mfa/passkey/registration-options") {
    state.challenge = randomBytes(32).toString("base64url");
    const user = Buffer.from("prn_evidence").toString("base64url");
    return [
      200,
      {
        ok: true,
        challenge: state.challenge,
        options: {
          rp: { name: "OpenSesame", id: new URL(pagesOrigin).hostname },
          user: { id: user, name: "prn_evidence", displayName: "prn_evidence" },
          challenge: state.challenge,
          pubKeyCredParams: [
            { type: "public-key", alg: -7 },
            { type: "public-key", alg: -257 },
          ],
          timeout: 60_000,
          attestation: "none",
          authenticatorSelection: {
            residentKey: "preferred",
            userVerification: "required",
          },
        },
      },
    ];
  }
  if (at === "POST /v1/mfa/passkey/register") {
    const factor = registered(state, body);
    if (!factor) return [401, { error: "registration_verification_failed" }];
    state.factors.push({ ...factor, createdAt: new Date().toISOString() });
    return [200, { ok: true, credentialId: "…", principalId: "prn_evidence" }];
  }
  if (at === "POST /v1/mfa/totp/enroll") {
    if (!state.factors.some((factor) => factor.kind === "totp")) {
      state.factors.push({ id: "totp", kind: "totp" });
    }
    return [
      200,
      {
        ok: true,
        secret: base32Decode(TOTP_SECRET).toString("base64"),
        otpauthUrl: `otpauth://totp/OpenSesame:prn_evidence?secret=${TOTP_SECRET}&issuer=OpenSesame`,
      },
    ];
  }
  if (at === "POST /v1/mfa/totp/verify") {
    return body.code === totpNow() ? [200, { ok: true }] : [401, { ok: false }];
  }
  const removal = /^DELETE \/v1\/mfa\/factors\/(totp|pk_[0-9a-f]{32})$/.exec(
    at,
  );
  if (removal) {
    const before = state.factors.length;
    state.factors = state.factors.filter((factor) => factor.id !== removal[1]);
    return state.factors.length === before
      ? [404, { ok: false, error: "not_found" }]
      : [200, { ok: true, id: removal[1] }];
  }
  return null;
}

export function factorSteps({ press }) {
  return {
    /**
     * Press the one action on the Security row named `row` — `Add`,
     * `Remove`… — when this build draws that row. A base build without the
     * account's rows does nothing here.
     */
    async rowActionOptional(page, { row, action }) {
      const target = page
        .locator(".sw", {
          has: page.locator(".sw__name", { hasText: row }),
        })
        .getByRole("button", { name: action, exact: true })
        .first();
      if (!(await target.count()) || !(await target.isEnabled())) return;
      await press(target);
      await page.waitForTimeout(1200);
    },
    /**
     * Type the stand-in seed's current code into the sheet's six digits,
     * the way a person reads it off their authenticator app.
     */
    async accountTotpCode(page) {
      const field = page.getByLabel("Six digits", { exact: true }).first();
      if (!(await field.count())) return;
      await field.fill(totpNow());
      await page.waitForTimeout(300);
    },
  };
}
