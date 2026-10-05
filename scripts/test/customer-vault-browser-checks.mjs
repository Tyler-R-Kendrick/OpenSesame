export async function verifyCustomerVaultIsolation() {
  const c = globalThis.vaultCrypto;
  const f = globalThis.vaultFiles;
  const passed = [];
  function check(condition, label) {
    if (!condition) throw new Error(label);
    passed.push(label);
  }
  async function refuses(operation, label) {
    let refused = false;
    try {
      await operation();
    } catch {
      refused = true;
    }
    check(refused, label);
  }
  const password = "shared operator browser fixture password";
  const a = await c.createVault(password);
  const b = await c.createVault(password);
  check(
    a.rawVaultKey.some((byte, index) => byte !== b.rawVaultKey[index]),
    "same password creates independent customer roots",
  );
  check(
    !a.vaultKey.extractable && !b.vaultKey.extractable,
    "session vault keys are non-extractable",
  );
  await refuses(
    () => crypto.subtle.exportKey("raw", a.vaultKey),
    "browser refuses raw session key export",
  );
  const directory = await navigator.storage.getDirectory();
  const store = {
    async putObject(key, bytes) {
      const file = await directory.getFileHandle(key, { create: true });
      const stream = await file.createWritable();
      await stream.write(bytes);
      await stream.close();
    },
    async getObject(key) {
      try {
        const file = await directory.getFileHandle(key);
        return new Uint8Array(await (await file.getFile()).arrayBuffer());
      } catch (error) {
        if (error.name === "NotFoundError") return null;
        throw error;
      }
    },
  };
  const files = await sealCustomerFiles(f, store, check);
  const { body, stored, binding } = await verifyCustomerBodies(
    c,
    a,
    b,
    store,
    files.aFile,
    check,
    refuses,
  );
  await verifyFileSwaps(f, store, files, refuses);
  await verifyRewrap({
    c,
    f,
    a,
    b,
    password,
    store,
    files,
    body,
    stored,
    binding,
    check,
    refuses,
  });
  a.rawVaultKey.fill(0);
  b.rawVaultKey.fill(0);
  return passed;
}

async function sealCustomerFiles(f, store, check) {
  const aBytes = new Uint8Array(f.FILE_PART_BYTES + 37).fill(65);
  const bBytes = new Uint8Array(f.FILE_PART_BYTES + 37).fill(66);
  const aFile = await f.sealFile({
    name: "a.bin",
    mediaType: "application/octet-stream",
    bytes: aBytes,
    stores: [store],
  });
  const bFile = await f.sealFile({
    name: "b.bin",
    mediaType: "application/octet-stream",
    bytes: bBytes,
    stores: [store],
  });
  const aManifest = JSON.parse(aFile);
  const bManifest = JSON.parse(bFile);
  check(
    aManifest.key !== bManifest.key && aManifest.parts.length === 2,
    "each customer attachment has independent random key and multiple chunks",
  );
  return { aBytes, bBytes, aFile, bFile, aManifest, bManifest };
}

async function richAccount(check, refuses) {
  const account = globalThis.vaultModel.createItem(
    "account",
    "customer A account",
  );
  const p = globalThis.vaultPepper;
  const { id: _generatorId, ...rules } = account.methods[0].generator;
  const pepper = "customer A typed pepper";
  const binding = p.pepperBinding(account.id, "peppered-password");
  const sealed = await p.sealWithPepper(
    "customer A nested password",
    pepper,
    binding,
  );
  check(
    sealed.v === 2 &&
      (await p.openWithPepper(sealed, pepper, binding)) ===
        "customer A nested password",
    "actual browser opens pepper-v2 password envelope",
  );
  await refuses(
    () => p.openWithPepper(sealed, "customer B typed pepper", binding),
    "another pepper refuses nested password envelope",
  );
  await refuses(
    () =>
      p.openWithPepper(
        sealed,
        pepper,
        p.pepperBinding("customer-b-account", "peppered-password"),
      ),
    "nested password seal refuses another account binding",
  );
  await refuses(
    () =>
      p.openWithPepper(
        sealed,
        pepper,
        p.pepperBinding(account.id, "other-method"),
      ),
    "nested password seal refuses another method binding",
  );
  account.username = "customer-a@example.test";
  account.uris = [
    {
      id: "customer-a-site",
      uri: "https://customer-a.example.test",
      match: "host",
    },
  ];
  account.methods = [
    { ...account.methods[0], secret: "customer A stored password" },
    {
      ...account.methods[0],
      id: "peppered-password",
      pepper: true,
      secret: "",
      sealed,
    },
    {
      id: "api",
      type: "api-key",
      key: "customer A API secret",
      header: "X-Api-Key",
    },
    {
      id: "token",
      type: "token",
      token: "customer A bearer token",
      expiresAt: "",
    },
    {
      id: "oauth",
      type: "oauth",
      clientId: "customer-a",
      clientSecret: "customer A OAuth secret",
      tokenUrl: "https://customer-a.example.test/token",
      scopes: "read",
      refreshToken: "customer A refresh token",
    },
    { id: "auth", type: "authenticator", secret: "JBSWY3DPEHPK3PXP" },
    {
      ...account.methods[0],
      id: "sphinx",
      pepper: true,
      secret: "",
      generator: {
        id: "sphinx",
        rules,
        realm: "customer-a.example.test",
        counter: 1,
        oprfKeyB64: globalThis.vaultBytes.bytesToB64(
          Uint8Array.from({ length: 32 }, (_, i) => (i === 0 ? 1 : 0)),
        ),
      },
    },
  ];
  return account;
}

async function verifyCustomerBodies(c, a, b, store, aFile, check, refuses) {
  const kinds = [
    "login",
    "totp",
    "passkey",
    "card",
    "secret",
    "note",
    "certificate",
    "drop",
    "customer.custom",
  ];
  const account = await richAccount(check, refuses);
  const body = {
    items: [
      account,
      ...kinds.map((kind) => ({
        kind,
        value: `customer A ${kind} secret`,
      })),
    ],
    attachment: aFile,
  };
  const binding = c.vaultSealBinding("customer-a-vault", "body");
  const envelope = await c.sealJson(a.vaultKey, body, binding);
  await store.putObject(
    "customer-a-body",
    new TextEncoder().encode(JSON.stringify(envelope)),
  );
  const stored = JSON.parse(
    new TextDecoder().decode(await store.getObject("customer-a-body")),
  );
  check(
    JSON.stringify(stored).indexOf("customer A") === -1,
    "OPFS stores encrypted secret bodies",
  );
  await refuses(
    () => c.openJson(b.vaultKey, stored, binding),
    "customer B root cannot open customer A secrets",
  );
  await refuses(
    () =>
      c.openJson(
        a.vaultKey,
        stored,
        c.vaultSealBinding("customer-b-vault", "body"),
      ),
    "body ciphertext cannot move between customer vault identities",
  );
  await refuses(
    () =>
      c.openJson(
        a.vaultKey,
        stored,
        c.vaultSealBinding("customer-a-vault", "other"),
      ),
    "body ciphertext cannot move between purposes",
  );
  return { body, stored, binding };
}

async function verifyFileSwaps(f, store, { aManifest, bManifest }, refuses) {
  await refuses(
    () =>
      f.openFile(JSON.stringify({ ...aManifest, key: bManifest.key }), [store]),
    "customer B file key cannot decrypt customer A chunks",
  );
  await refuses(
    () =>
      f.openFile(
        JSON.stringify({
          ...aManifest,
          parts: [aManifest.parts[1], aManifest.parts[0]],
        }),
        [store],
      ),
    "attachment chunk reordering is rejected",
  );
}

async function verifyRewrap({
  c,
  f,
  a,
  b,
  password,
  store,
  files: { aBytes, bFile },
  body,
  stored,
  binding,
  check,
  refuses,
}) {
  const next = await c.rewrapVaultKey(
    a.header,
    password,
    "rotated customer A browser password",
  );
  await refuses(
    () => c.unlockVaultKey(next, password),
    "rotated customer protector refuses old password",
  );
  const reopened = await c.unlockVaultKey(
    next,
    "rotated customer A browser password",
  );
  const opened = await c.openJson(reopened, stored, binding);
  check(
    JSON.stringify(opened) === JSON.stringify(body),
    "customer protector rewrap preserves all secret kinds and attachment manifest",
  );
  const attachment = await f.openFile(opened.attachment, [store]);
  check(
    attachment.bytes.length === aBytes.length &&
      attachment.bytes.every((byte) => byte === 65),
    "rewrapped customer vault opens every OPFS attachment chunk",
  );
  const bOpened = await f.openFile(bFile, [store]);
  check(
    bOpened.bytes.every((byte) => byte === 66),
    "other customer attachment remains readable after rewrap",
  );
  await store.putObject(
    "customer-a-header",
    new TextEncoder().encode(JSON.stringify(next)),
  );
}
