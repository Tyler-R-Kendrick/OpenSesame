/**
 * Q harness — the wallet pass and the interaction reference, end to end
 * (ADR 0086 §§3, 5, 6).
 *
 * The per-package suites each prove one layer: `provider.test.ts` proves the
 * factory selects a real Google provider from a complete environment,
 * `google.test.ts` proves a save link decodes to a Generic object, and
 * os-domain's `interaction-ref.test.ts` proves a reference is MAC-bound. What
 * none of them proves is the seam Swarm Q is accountable for: a reference
 * minted by the *production* os-domain factory, carried by a pass built by the
 * *production* wallet factory, is worth nothing to whoever photographs the
 * card. So this harness wires the real factories together and asserts the one
 * property that only their composition can show — the barcode is the canonical
 * URL and nothing else, the reference still round-trips its MAC, and the
 * request digest never rode along.
 *
 * No factory is mocked. The Google provider signs a real RS256 save link with
 * a locally generated key, and the harness verifies it with the matching
 * public key, so the bytes inspected are the bytes a phone would receive.
 */

import { generateKeyPairSync } from "node:crypto";
import {
  bindingMessageDigest,
  canonicalRequestDigest,
  interactionRef,
  mintInteractionRef,
  overlapCast,
  resolveInteractionRef,
} from "@opensesame/os-domain";
import { importSPKI, jwtVerify } from "jose";
import { describe, expect, it } from "vitest";
import { GOOGLE_WALLET_ENV, parseGoogleWalletConfig } from "./config.js";
import { createGoogleWalletProvider } from "./google.js";
import { createWalletProvider } from "./index.js";
import { WalletPayloadRejected } from "./payload.js";

const { publicKey, privateKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  publicKeyEncoding: { type: "spki", format: "pem" },
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
});

const BASE_URL = "https://interactions.example.test";
const SAVE_LINK_PREFIX = "https://pay.google.com/gp/v/save/";

/** A pepper the harness holds, standing in for a deployment's claim pepper. */
const PEPPER = "q-harness-interaction-pepper";

/** A complete Google environment — the production factory yields a real adapter. */
function walletEnv() {
  return {
    [GOOGLE_WALLET_ENV.issuerId]: "3388000000022125777",
    [GOOGLE_WALLET_ENV.classId]: "interaction",
    [GOOGLE_WALLET_ENV.serviceAccountEmail]:
      "wallet@opensesame-test.iam.gserviceaccount.com",
    [GOOGLE_WALLET_ENV.serviceAccountKeyPem]: privateKey,
    [GOOGLE_WALLET_ENV.publicBaseUrl]: BASE_URL,
    [GOOGLE_WALLET_ENV.origins]: BASE_URL,
  };
}

/**
 * The Google adapter reached through the config parser and the adapter factory
 * — the same two production functions `createWalletProvider` calls once it has
 * decided the environment is complete.
 */
function googleProvider() {
  const config = parseGoogleWalletConfig(walletEnv());
  if (!config.enabled) throw new Error("expected a complete wallet env");
  return createGoogleWalletProvider({ config });
}

/** The Generic objects a decoded save link carries; named so no cast widens. */
interface SaveLinkClaims {
  payload: {
    genericObjects: {
      barcode: { type: string; value: string };
      linksModuleData: { uris: { uri: string }[] };
    }[];
  };
}

/** Decode and verify a save link with the matching public key. */
async function decode(saveUrl: string): Promise<SaveLinkClaims> {
  expect(saveUrl.startsWith(SAVE_LINK_PREFIX)).toBe(true);
  const jwt = saveUrl.slice(SAVE_LINK_PREFIX.length);
  const { payload } = await jwtVerify(
    jwt,
    await importSPKI(publicKey, "RS256"),
  );
  // The annotation supplies the target; overlapCast call sites omit type args.
  const claims: SaveLinkClaims = overlapCast(payload);
  return claims;
}

const NEVER_EXPIRES = new Date("2030-01-01T00:00:00.000Z");

describe("Q: a wallet pass fronts a real interaction and leaks nothing (ADR 0086)", () => {
  it("carries the canonical URL as its only barcode, and no request secret", async () => {
    // The reference is minted by the production os-domain factory, exactly as
    // the control plane mints one before drawing a QR or a pass.
    const { id, ref } = mintInteractionRef(PEPPER);
    const interactionUrl = `${BASE_URL}/i/${ref}`;

    // The digest an approval will be bound to. It is computed here to prove a
    // negative: a value this sensitive must never reach the pass.
    const requestDigest = canonicalRequestDigest({
      kind: "transaction_authorization",
      subject: `transaction_authorization:${id}`,
      approverRef: "inbox_q_approver",
      requesterRef: "req_q_requester",
      authorizationDetails: [
        {
          type: "payment_initiation",
          amount: { currency: "USD", value: "143.72" },
          payee: { display_name: "AliceCo" },
        },
      ],
      bindingMessage: "Pay 143.72 USD to AliceCo",
      expiresAt: NEVER_EXPIRES.toISOString(),
    });
    const bindingDigest = bindingMessageDigest(
      "Pay 143.72 USD to AliceCo",
      PEPPER,
    );

    const wallet = createWalletProvider(walletEnv());
    expect(wallet.capabilities().provider).toBe("google");

    const artifact = await wallet.issuePass({
      interactionRef: ref,
      interactionUrl,
      kind: "transaction_authorization",
      title: "Approve a transaction",
      expiresAt: NEVER_EXPIRES,
    });

    const claims = await decode(artifact.saveUrl);
    const object = claims.payload.genericObjects[0];
    expect(object).toBeDefined();
    // The one thing the barcode may be: the canonical URL, verbatim.
    expect(object?.barcode).toEqual({ type: "QR_CODE", value: interactionUrl });
    expect(object?.linksModuleData.uris[0]?.uri).toBe(interactionUrl);

    // The seam that matters: nothing bound to the approval rode along on a
    // surface that lands on a stranger's lock screen.
    const serialized = JSON.stringify(claims);
    for (const secret of [
      requestDigest,
      bindingDigest,
      id, // the fronted row's id never travels — only the reference does
      "143.72",
      "AliceCo",
      "payment_initiation",
    ]) {
      expect(serialized).not.toContain(secret);
    }
  });

  it("the barcode reference round-trips its MAC and is not a bearer", async () => {
    const { id, ref } = mintInteractionRef(PEPPER);
    const wallet = googleProvider();
    const artifact = await wallet.issuePass({
      interactionRef: ref,
      interactionUrl: `${BASE_URL}/i/${ref}`,
      kind: "device_authorization",
      title: "Approve a device",
      expiresAt: NEVER_EXPIRES,
    });

    const claims = await decode(artifact.saveUrl);
    const carried = new URL(
      claims.payload.genericObjects[0]?.barcode.value ?? "",
    ).pathname.slice("/i/".length);
    expect(carried).toBe(ref);

    // Resolving the reference the pass carries returns the fronted id — under
    // the minting pepper, and only under it.
    expect(resolveInteractionRef(carried, PEPPER)).toBe(id);
    expect(resolveInteractionRef(carried, "a-different-deployment")).toBeNull();

    // A one-character MAC flip is refused before any lookup — a photographed
    // pass cannot be edited into a reference for a neighbouring interaction.
    const tail = carried.at(-1) === "A" ? "B" : "A";
    const forged = `${carried.slice(0, -1)}${tail}`;
    expect(resolveInteractionRef(forged, PEPPER)).toBeNull();

    // And a reference this deployment really did mint, for a row that never
    // existed, resolves to a *shape* but is not the one on the pass.
    const orphan = interactionRef("int_0000000000000000000000000", PEPPER);
    expect(orphan).not.toBe(carried);
  });

  it("the production issue path refuses a display row smuggling a secret", async () => {
    const { ref } = mintInteractionRef(PEPPER);
    const wallet = googleProvider();
    const pan = "4111 1111 1111 1111"; // Luhn-valid: a PAN under an innocuous label.

    let rejected: WalletPayloadRejected | undefined;
    try {
      await wallet.issuePass({
        interactionRef: ref,
        interactionUrl: `${BASE_URL}/i/${ref}`,
        kind: "device_authorization",
        title: "Approve a device",
        expiresAt: NEVER_EXPIRES,
        displayRows: [{ label: "Reference", value: pan }],
      });
    } catch (error) {
      // A catch binding, not a parameter: the payload gate is the only thing
      // that may throw here, and anything else is a real failure worth surfacing.
      if (!(error instanceof WalletPayloadRejected)) throw error;
      rejected = error;
    }

    expect(rejected).toBeInstanceOf(WalletPayloadRejected);
    // The refusal names a path, never the value it caught.
    expect(rejected?.message).not.toContain(pan);
    expect((rejected?.path ?? "").length).toBeGreaterThan(0);
  });
});
