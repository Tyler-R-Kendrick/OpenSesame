import { generateKeyPairSync, verify } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterEach, expect, it, vi } from "vitest";
import type { NativeApiConfigureInput } from "./native-api-connectors.js";
import type { NativeProviderTransport } from "./native-connector-transport.js";
import { googleWalletKeyFlows } from "./native-google-wallet.js";
import { runtimeFixture } from "./secret-backends/runtime.test-support.js";

const vectors = JSON.parse(
  readFileSync(
    fileURLToPath(
      new URL(
        "../../../../spec/conformance/google-wallet-configuration.json",
        import.meta.url,
      ),
    ),
    "utf8",
  ),
);
const rsa = generateKeyPairSync("rsa", { modulusLength: 2048 });
const pkcs8 = rsa.privateKey
  .export({ type: "pkcs8", format: "pem" })
  .toString();
const pkcs1 = rsa.privateKey
  .export({ type: "pkcs1", format: "pem" })
  .toString();
const ec = generateKeyPairSync("ec", { namedCurve: "P-384" })
  .privateKey.export({ type: "pkcs8", format: "pem" })
  .toString();
const keys = new Map<string, string>([
  ["generated_pkcs8_rsa", pkcs8],
  ["generated_pkcs8_rsa_escaped", pkcs8.replace(/\n/g, "\\n")],
  ["generated_pkcs1_rsa", pkcs1],
  ["not-a-private-key", "not-a-private-key"],
  ["oversized", "a".repeat(32769)],
  [
    "invalid_der",
    `-----BEGIN PRIVATE KEY-----\n${"A".repeat(256)}\n-----END PRIVATE KEY-----`,
  ],
  ["generated_ec_pkcs8", ec],
  [
    "invalid_padding",
    `-----BEGIN PRIVATE KEY-----\n${"A".repeat(240)}=A\n-----END PRIVATE KEY-----`,
  ],
]);
const email = "wallet@project-name.iam.gserviceaccount.com";
const owner = new AbortController();
const closes: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of closes.splice(0).reverse()) await close();
});
function input(
  issuer: string,
  classId: string,
  clientEmail: string,
  key: string,
): NativeApiConfigureInput {
  return {
    providerId: "google-wallet",
    displayName: "Wallet conformance",
    parameters: {
      issuer_id: issuer,
      class_id: classId,
      origin: "https://operator.example.test",
    },
    credentials: {
      service_account_json: JSON.stringify({
        type: "service_account",
        client_email: clientEmail,
        private_key: key,
      }),
    },
  };
}
function transportFor(expectedEmail: string) {
  const fetcher = vi.fn<typeof fetch>(async (raw, init) => {
    const req = new Request(raw, init);
    const url = new URL(req.url);
    if (url.href === "https://oauth2.googleapis.com/token") {
      expect(req.method).toBe("POST");
      const form = new URLSearchParams(await req.text());
      expect(form.get("grant_type")).toBe(
        "urn:ietf:params:oauth:grant-type:jwt-bearer",
      );
      const assertion = form.get("assertion") ?? "";
      const [header, payload, signature] = assertion.split(".");
      if (
        !header ||
        !payload ||
        !signature ||
        !verify(
          "RSA-SHA256",
          Buffer.from(`${header}.${payload}`),
          rsa.publicKey,
          Buffer.from(signature, "base64url"),
        )
      )
        throw new Error("Unverified assertion");
      expect(
        JSON.parse(Buffer.from(payload, "base64url").toString()),
      ).toMatchObject({
        iss: expectedEmail.toLowerCase(),
        aud: "https://oauth2.googleapis.com/token",
        scope: "https://www.googleapis.com/auth/wallet_object.issuer",
      });
      return Response.json({
        access_token: "synthetic-wallet-token-000000000000",
        expires_in: 3600,
        token_type: "Bearer",
      });
    }
    if (
      url.origin !== "https://walletobjects.googleapis.com" ||
      !url.pathname.startsWith("/walletobjects/v1/genericClass/")
    )
      throw new Error("Unexpected endpoint");
    expect(req.method).toBe("GET");
    expect(req.headers.get("authorization")).toBe(
      "Bearer synthetic-wallet-token-000000000000",
    );
    return Response.json({
      id: decodeURIComponent(
        url.pathname.slice("/walletobjects/v1/genericClass/".length),
      ),
    });
  });
  return {
    fetcher,
    transport: {
      fetch: fetcher,
      signal: owner.signal,
      assertCurrent: () => {},
      supportsNativeOrigin: () => true,
    } satisfies NativeProviderTransport,
  };
}
it("replays public vectors through the specialized verified-key driver", async () => {
  const fixture = await runtimeFixture();
  closes.push(() => fixture.close());
  for (const item of vectors.public_cases) {
    const { transport, fetcher } = transportFor(item.service_account_email);
    const result = googleWalletKeyFlows.configure(
      input(item.issuer_id, item.class_id, item.service_account_email, pkcs8),
      transport,
    );
    if (item.native_verified_entry_accepted) {
      await expect(result, item.name).resolves.toMatchObject({
        status: "connected",
      });
      expect(fetcher, item.name).toHaveBeenCalledTimes(2);
    } else {
      await expect(result, item.name).rejects.toThrow();
      expect(fetcher, item.name).not.toHaveBeenCalled();
    }
  }
});
it("replays every issuer and class vector with a valid service account", async () => {
  const fixture = await runtimeFixture();
  closes.push(() => fixture.close());
  for (const item of vectors.public_cases) {
    const { transport, fetcher } = transportFor(email);
    const result = googleWalletKeyFlows.configure(
      input(item.issuer_id, item.class_id, email, pkcs8),
      transport,
    );
    if (item.native_verified_with_valid_account) {
      await expect(result, item.name).resolves.toMatchObject({
        status: "connected",
      });
      expect(fetcher, item.name).toHaveBeenCalledTimes(2);
    } else {
      await expect(result, item.name).rejects.toThrow();
      expect(fetcher, item.name).not.toHaveBeenCalled();
    }
  }
});
it("replays private-key vectors through the specialized verified-key driver", async () => {
  const fixture = await runtimeFixture();
  closes.push(() => fixture.close());
  for (const item of vectors.key_cases) {
    const key = keys.get(item.value);
    if (key === undefined) throw new Error(`Unknown key fixture ${item.value}`);
    const { transport, fetcher } = transportFor(email);
    const result = googleWalletKeyFlows.configure(
      input("123456", "pass", email, key),
      transport,
    );
    if (item.native_verified_entry_accepted) {
      await expect(result, item.name).resolves.toMatchObject({
        status: "connected",
      });
      expect(fetcher, item.name).toHaveBeenCalledTimes(2);
    } else {
      await expect(result, item.name).rejects.toThrow();
      expect(fetcher, item.name).not.toHaveBeenCalled();
    }
  }
});

it("replays service-account JSON boundary vectors through the verified driver", async () => {
  const fixture = await runtimeFixture();
  closes.push(() => fixture.close());
  const account = {
    type: "service_account",
    client_email: email,
    private_key: pkcs8,
  };
  const samples = new Map<string, string>([
    ["valid", JSON.stringify(account)],
    [
      "legacy_domain",
      JSON.stringify({
        ...account,
        client_email: "wallet@project-name.gserviceaccount.com",
      }),
    ],
    ["wrong_type", JSON.stringify({ ...account, type: "authorized_user" })],
    [
      "missing_type",
      JSON.stringify({ client_email: email, private_key: pkcs8 }),
    ],
    [
      "missing_email",
      JSON.stringify({ type: account.type, private_key: pkcs8 }),
    ],
    ["number_email", JSON.stringify({ ...account, client_email: 42 })],
    [
      "missing_key",
      JSON.stringify({ type: account.type, client_email: email }),
    ],
    ["number_key", JSON.stringify({ ...account, private_key: 42 })],
    ["malformed", "{"],
    ["array", "[]"],
    [
      "oversized_json",
      JSON.stringify({ ...account, extra: "x".repeat(32768) }),
    ],
    [
      "uppercase_project",
      JSON.stringify({
        ...account,
        client_email: "wallet@Project-name.iam.gserviceaccount.com",
      }),
    ],
    [
      "email_whitespace",
      JSON.stringify({ ...account, client_email: ` ${email}` }),
    ],
    [
      "short_project",
      JSON.stringify({
        ...account,
        client_email: "wallet@abc.iam.gserviceaccount.com",
      }),
    ],
    [
      "escaped_newlines",
      JSON.stringify({ ...account, private_key: pkcs8.replace(/\n/g, "\\n") }),
    ],
    [
      "trailing_pem_whitespace",
      JSON.stringify({ ...account, private_key: `${pkcs8}  \n` }),
    ],
  ]);
  for (const item of vectors.native_service_account_cases) {
    const raw = samples.get(item.value);
    if (raw === undefined)
      throw new Error(`Unknown account fixture ${item.value}`);
    const { transport, fetcher } = transportFor(
      item.value === "legacy_domain"
        ? "wallet@project-name.gserviceaccount.com"
        : email,
    );
    const draft = input("123456", "pass", email, pkcs8);
    draft.credentials.service_account_json = raw;
    const result = googleWalletKeyFlows.configure(draft, transport);
    if (item.accepted) {
      await expect(result, item.name).resolves.toMatchObject({
        status: "connected",
      });
      expect(fetcher, item.name).toHaveBeenCalledTimes(2);
    } else {
      await expect(result, item.name).rejects.toThrow();
      expect(fetcher, item.name).not.toHaveBeenCalled();
    }
  }
});
