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
 *
 * A new passkey's one try (plan step 11c): request options over the
 * credential just registered, and an assertion accepted only when its
 * `clientDataJSON` is a `webauthn.get` over the challenge handed out — or,
 * when the journey says `"passkeyAssert": "refuse"`, turned down with the
 * Identity API's own 401 `{ ok: false }`, to show a passkey saved but not
 * tried to the end.
 *
 * Removal (ADR 0146). A delete that carries a proof is verified the way the
 * Identity API does: a code must be the seed's current one, and a step is
 * accepted once (shared with `/totp/verify`); an assertion must be a
 * `webauthn.get` over the challenge minted for removing that one factor
 * (`authentication-options` with `{purpose: "factor.remove", factorId}`),
 * spent once. A wrong proof is the service's 403 `step_up_failed`. A delete
 * with no proof at all is answered as the service before ADR 0146 answered
 * it — removed — so a capture of the base build walks the base's own flow.
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

/** The last RFC 6238 step the stand-in accepted a code for (RFC 6238 §5.2). */
let spentStep = -1;

function spendCode(code) {
  const step = Math.floor(Date.now() / 30_000);
  if (code !== totpNow() || step <= spentStep) return false;
  spentStep = step;
  return true;
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

/** One page's account: its factors and the challenges last handed out. */
export function factorState({ assert = "accept" } = {}) {
  return {
    factors: [],
    challenge: null,
    assertChallenge: null,
    credentialIds: [],
    removal: null,
    assert,
  };
}

function clientData(encoded) {
  try {
    return JSON.parse(Buffer.from(encoded, "base64url").toString());
  } catch {
    return null;
  }
}

/** The one try of a passkey just added: its options, then its assertion. */
function answerTry(state, at, body, rpId) {
  if (
    at === "POST /v1/mfa/passkey/authentication-options" &&
    body.purpose === "factor.remove"
  ) {
    if (!state.factors.some((factor) => factor.id === body.factorId)) {
      return [404, { ok: false, error: "not_found" }];
    }
    const challenge = randomBytes(32).toString("base64url");
    state.removal = { challenge, factorId: body.factorId };
    return [
      200,
      {
        ok: true,
        challenge,
        options: { challenge, rpId, userVerification: "required" },
      },
    ];
  }
  if (at === "POST /v1/mfa/passkey/authentication-options") {
    state.assertChallenge = randomBytes(32).toString("base64url");
    return [
      200,
      {
        ok: true,
        challenge: state.assertChallenge,
        options: {
          challenge: state.assertChallenge,
          rpId,
          allowCredentials: state.credentialIds.map((id) => ({
            id,
            type: "public-key",
          })),
          userVerification: "required",
          timeout: 60_000,
        },
      },
    ];
  }
  if (at === "POST /v1/mfa/passkey/assert") {
    const client = clientData(body.clientDataJSON ?? "");
    const fresh =
      client?.type === "webauthn.get" &&
      client.challenge === state.assertChallenge;
    state.assertChallenge = null;
    if (state.assert === "refuse" || !fresh) return [401, { ok: false }];
    return [200, { ok: true, principalId: "prn_evidence" }];
  }
  return null;
}

function registered(state, body) {
  const response = body.response;
  if (!response?.response?.attestationObject) return null;
  const client = clientData(response.response.clientDataJSON);
  if (
    client?.type !== "webauthn.create" ||
    client.challenge !== state.challenge
  )
    return null;
  state.challenge = null;
  state.credentialIds.push(response.rawId);
  const digest = createHash("sha256").update(response.id).digest("hex");
  return { id: `pk_${digest.slice(0, 32)}`, kind: "passkey" };
}

/**
 * Answer an account-factor route at `at` (`METHOD /path`), or `null`. The
 * relying party id is the Pages origin's host.
 */
export function answerFactors(state, at, request, pagesOrigin) {
  const body = bodyOf(request);
  const tried = answerTry(state, at, body, new URL(pagesOrigin).hostname);
  if (tried) return tried;
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
    return spendCode(body.code) ? [200, { ok: true }] : [401, { ok: false }];
  }
  const removal = /^DELETE \/v1\/mfa\/factors\/(totp|pk_[0-9a-f]{32})$/.exec(
    at,
  );
  if (removal) {
    if (body.proof && !proved(state, removal[1], body.proof)) {
      return [403, { ok: false, error: "step_up_failed" }];
    }
    const before = state.factors.length;
    state.factors = state.factors.filter((factor) => factor.id !== removal[1]);
    return state.factors.length === before
      ? [404, { ok: false, error: "not_found" }]
      : [200, { ok: true, id: removal[1] }];
  }
  return null;
}

/** A removal's proof, checked as the Identity API checks it (ADR 0146). */
function proved(state, factorId, proof) {
  if (proof.kind === "totp") return spendCode(proof.code);
  const minted = state.removal;
  state.removal = null;
  const client = clientData(proof.clientDataJSON ?? "");
  return (
    proof.kind === "passkey" &&
    minted?.factorId === factorId &&
    client?.type === "webauthn.get" &&
    client.challenge === minted.challenge
  );
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
     * Press the key with exactly this name inside the open sheet, when there
     * is one and it has that key — never a same-named key behind it.
     */
    async sheetPressOptional(page, name) {
      const target = page
        .locator("[role=dialog]")
        .getByRole("button", { name, exact: true })
        .first();
      if (!(await target.count()) || !(await target.isEnabled())) return;
      await press(target);
      await page.waitForTimeout(1200);
    },
    /** Print what each status mark in the open sheet says, and its tone. */
    async sheetMarks(page) {
      const marks = await page
        .locator("[role=dialog] .status-mark")
        .evaluateAll((nodes) =>
          nodes.map(
            (node) =>
              `${node.className.replace("status-mark ", "")}: ${node.getAttribute("aria-label")} (live: ${node.closest("[aria-live]")?.getAttribute("aria-live") ?? "none"})`,
          ),
        );
      console.log(`  sheet marks: ${marks.join(" | ") || "none"}`);
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
    /**
     * The same, once the authenticator shows a code the stand-in has not
     * accepted yet: a step is good once (RFC 6238 §5.2), so a person
     * waits for the next code rather than typing the one just used.
     */
    async accountTotpFreshCode(page) {
      const field = page.getByLabel("Six digits", { exact: true }).first();
      if (!(await field.count())) return;
      while (Math.floor(Date.now() / 30_000) <= spentStep) {
        await page.waitForTimeout(1000);
      }
      await field.fill(totpNow());
      await page.waitForTimeout(300);
    },
  };
}
