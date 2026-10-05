/** Test fixtures represent already authenticated SDK storage, rather than legacy cleartext. */
import { createCipheriv, randomBytes } from "node:crypto";
export const FIXTURE_ROOT = new Uint8Array(32).fill(41);

export function fixtureValue(
  name: string,
  value: string,
  issuer: string,
  clientId?: string,
): string {
  if (!name.endsWith(":pkce") && !name.endsWith(":session")) return value;
  if (value.startsWith("osc")) return value;
  const owner =
    clientId ??
    (name.endsWith(":pkce") ? "opensesame-browser" : "origin:http://127.0.0.1");
  const context = Buffer.from(
    JSON.stringify([
      "opensesame.client-envelope.v2",
      JSON.stringify(["sdk-browser", issuer, owner]),
      name,
    ]),
  );
  const encrypt = (key: Uint8Array, iv: Buffer, plain: Buffer, aad: Buffer) => {
    const cipher = createCipheriv("aes-256-gcm", key, iv);
    cipher.setAAD(aad);
    return Buffer.concat([
      cipher.update(plain),
      cipher.final(),
      cipher.getAuthTag(),
    ]);
  };
  const dek = randomBytes(32);
  try {
    const wrapIv = randomBytes(12);
    const iv = randomBytes(12);
    const header = Buffer.concat([
      wrapIv,
      encrypt(FIXTURE_ROOT, wrapIv, dek, context),
      iv,
    ]);
    return `osc2.${Buffer.concat([header, encrypt(dek, iv, Buffer.from(value), Buffer.concat([context, header]))]).toString("base64")}`;
  } finally {
    dek.fill(0);
  }
}

export class SdkFixtureStorage {
  readonly #rows = new Map<string, string>();
  constructor(
    private readonly issuer: string,
    private readonly clientId?: string,
  ) {}
  getItem(key: string): string | null {
    return this.#rows.get(key) ?? null;
  }
  setItem(key: string, value: string): void {
    this.#rows.set(key, fixtureValue(key, value, this.issuer, this.clientId));
  }
  removeItem(key: string): void {
    this.#rows.delete(key);
  }
}

export function legacyFixtureValue(name: string, value: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", FIXTURE_ROOT, iv);
  cipher.setAAD(
    Buffer.from(`opensesame.client-at-rest.v1\0sdk-browser\0${name}`),
  );
  return `osc1.${Buffer.concat([iv, cipher.update(value), cipher.final(), cipher.getAuthTag()]).toString("base64")}`;
}
