import type { BoundaryValue } from "@opensesame/os-domain";
import {
  type SealedBlob,
  bytesToB64,
  importVaultKey,
  openJson,
  vaultSealBinding,
} from "@opensesame/vault-core";
import * as gcm from "@opensesame/vault-core/gcm.js";
import { expect, it, vi } from "vitest";
import { openBoundHumanVaultBodyData } from "./human-vault-body-data.js";
import { verifyHumanVaultData } from "./human-vault-data.js";
import {
  tomb,
  unavailable,
  useFixture,
} from "./human-vault-data.test-support.js";

async function sealBytes(
  root: Uint8Array,
  plaintext: Uint8Array,
): Promise<SealedBlob> {
  const key = await importVaultKey(root);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const sealed = await gcm.gcmSeal(
    key,
    plaintext,
    iv,
    new TextEncoder().encode(vaultSealBinding(tomb, "body")),
  );
  return { ivB64: bytesToB64(iv), ctB64: bytesToB64(sealed) };
}

async function sealText(root: Uint8Array, raw: string): Promise<SealedBlob> {
  const bytes = new TextEncoder().encode(raw);
  try {
    return await sealBytes(root, bytes);
  } finally {
    bytes.fill(0);
  }
}

it("keeps nested decimals, deep items and opaque metadata-looking strings as ordinary BODY data", () =>
  useFixture(async (value) => {
    let nested: BoundaryValue = 1.25;
    for (let i = 0; i < 24; i++) nested = { child: nested };
    const expected = {
      v: 1,
      rev: 0,
      items: [{ data: { amount: 1.25, nested, text: '{"rev":-0,"v":1e0}' } }],
      folders: [],
    };
    const body = await sealText(value.root, JSON.stringify(expected));
    const key = await importVaultKey(value.root);
    expect(await openBoundHumanVaultBodyData(key, body, tomb)).toEqual(
      expected,
    );
    await expect(
      verifyHumanVaultData(
        tomb,
        JSON.stringify(value.header),
        body,
        value.root,
      ),
    ).resolves.toMatchObject({ bodyRevision: 0 });
    const duplicateNested = await sealText(
      value.root,
      '{"v":1,"rev":0,"items":[{"data":{"n":0,"n":1}}],"folders":[]}',
    );
    expect(
      await openBoundHumanVaultBodyData(key, duplicateNested, tomb),
    ).toEqual(
      await openJson(key, duplicateNested, vaultSealBinding(tomb, "body")),
    );
  }));

it("refuses decoded duplicate top-level keys and lexical aliases only for top-level metadata integers", () =>
  useFixture(async (value) => {
    const header = JSON.stringify(value.header);
    for (const raw of [
      '{"v":1,"\\u0076":1,"items":[],"folders":[]}',
      '{"v":1,"extra":0,"\\u0065xtra":1,"items":[],"folders":[]}',
      '{"v":1e0,"rev":0,"items":[],"folders":[]}',
      ...["-0", "1.0000000000000001", "9007199254740992"].map(
        (rev) => `{"v":1,"rev":${rev},"items":[],"folders":[]}`,
      ),
    ]) {
      const body = await sealText(value.root, raw);
      await expect(
        verifyHumanVaultData(tomb, header, body, value.root),
      ).rejects.toThrow(unavailable);
    }
    const maximum = await sealText(
      value.root,
      '{"v":1,"rev":9007199254740991,"items":[],"folders":[]}',
    );
    await expect(
      verifyHumanVaultData(tomb, header, maximum, value.root),
    ).resolves.toMatchObject({ bodyRevision: Number.MAX_SAFE_INTEGER });
  }));

function invalidUtf8Body(): Uint8Array {
  const prefix = new TextEncoder().encode('{"v":1,"items":[{"text":"');
  const suffix = new TextEncoder().encode('"}],"folders":[]}');
  const bytes = new Uint8Array(prefix.length + 2 + suffix.length);
  bytes.set(prefix);
  bytes.set([0xc3, 0x28], prefix.length);
  bytes.set(suffix, prefix.length + 2);
  return bytes;
}

it("refuses genuinely AEAD-authenticated invalid UTF-8 while leaving public openJson compatibility unchanged", () =>
  useFixture(async (value) => {
    const bytes = invalidUtf8Body();
    try {
      const body = await sealBytes(value.root, bytes);
      const key = await importVaultKey(value.root);
      // Public legacy JSON decode still accepts replacement text; only this data boundary tightens.
      await expect(
        openJson(key, body, vaultSealBinding(tomb, "body")),
      ).resolves.toMatchObject({ items: [{ text: "\ufffd(" }] });
      await expect(
        verifyHumanVaultData(
          tomb,
          JSON.stringify(value.header),
          body,
          value.root,
        ),
      ).rejects.toThrow(unavailable);
      await expect(
        verifyHumanVaultData(
          tomb,
          JSON.stringify(value.header),
          value.body,
          value.root,
        ),
      ).resolves.toMatchObject({ bodyRevision: 0 });
    } finally {
      bytes.fill(0);
    }
  }));

it("zeros the owned actual decrypted bytes on successful parsing and failed metadata or UTF-8 decoding", () =>
  useFixture(async (value) => {
    const actualOpen = gcm.gcmOpen;
    const opened: Uint8Array[] = [];
    const observe = vi
      .spyOn(gcm, "gcmOpen")
      .mockImplementation(async (...args) => {
        const bytes = await actualOpen(...args);
        opened.push(bytes);
        return bytes;
      });
    try {
      const header = JSON.stringify(value.header);
      await expect(
        verifyHumanVaultData(tomb, header, value.body, value.root),
      ).resolves.toMatchObject({ bodyRevision: 0 });
      const badMetadata = await sealText(
        value.root,
        '{"v":1,"rev":1e0,"items":[],"folders":[]}',
      );
      await expect(
        verifyHumanVaultData(tomb, header, badMetadata, value.root),
      ).rejects.toThrow(unavailable);
      const badGrammar = await sealText(
        value.root,
        '{"v":1,"rev":0,"items":[],"folders":[],}',
      );
      await expect(
        verifyHumanVaultData(tomb, header, badGrammar, value.root),
      ).rejects.toThrow(unavailable);
      const raw = invalidUtf8Body();
      try {
        const badUtf8 = await sealBytes(value.root, raw);
        await expect(
          verifyHumanVaultData(tomb, header, badUtf8, value.root),
        ).rejects.toThrow(unavailable);
      } finally {
        raw.fill(0);
      }
      expect(opened).toHaveLength(4);
      for (const bytes of opened) {
        expect(bytes.length).toBeGreaterThan(0);
        expect(bytes.every((byte) => byte === 0)).toBe(true);
      }
    } finally {
      observe.mockRestore();
    }
  }));
