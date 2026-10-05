const FIXTURE = "opensesame.customer-record-checks";
const STORE = "customer-records";
const NAME = "customer-a/token";
const RECORD = "opensesame.customer-record-a";

function check(condition, label) {
  if (!condition) throw new Error(label);
  return label;
}

async function keyRecord() {
  const database = await new Promise((resolve, reject) => {
    const request = indexedDB.open("opensesame-at-rest", 1);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  try {
    return await new Promise((resolve, reject) => {
      const request = database
        .transaction("keys")
        .objectStore("keys")
        .get("device");
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  } finally {
    database.close();
  }
}

async function wrappingRootChecks(root) {
  const stored = await keyRecord();
  check(
    stored.wrapped instanceof ArrayBuffer && stored.wrapped.byteLength === 48,
    "record root persists wrapped in actual IndexedDB",
  );
  check(
    !stored.wrappingKey.extractable && !("key" in stored),
    "record wrapping root is non-extractable and no raw root is stored",
  );
  let refused = false;
  try {
    await crypto.subtle.exportKey("raw", stored.wrappingKey);
  } catch {
    refused = true;
  }
  check(refused, "browser refuses record wrapping root export");
  const unwrapped = new Uint8Array(
    await crypto.subtle.decrypt(
      {
        name: "AES-GCM",
        iv: stored.iv,
        additionalData: new TextEncoder().encode("opensesame.at-rest.wrap.v1"),
      },
      stored.wrappingKey,
      stored.wrapped,
    ),
  );
  check(
    unwrapped.every((byte, index) => byte === root[index]),
    "production key loader unwraps the persisted root",
  );
  unwrapped.fill(0);
}

function unwrapRecordDataKey(root, binding, envelope) {
  const { hkdf, sha256, xchacha20poly1305 } = globalThis.recordPrimitives;
  const { b64urlToBytes, bytesToB64url } = globalThis.vaultBytes;
  const packed = b64urlToBytes(envelope.slice(5));
  const key = hkdf(
    sha256,
    root,
    new TextEncoder().encode("opensesame.at-rest.v2.kek"),
    binding,
    32,
  );
  try {
    const aad = new TextEncoder().encode(
      JSON.stringify(["osr2", "wrap", bytesToB64url(binding)]),
    );
    return xchacha20poly1305(key, packed.subarray(0, 24), aad).decrypt(
      packed.subarray(24, 72),
    );
  } finally {
    key.fill(0);
  }
}

function recordIsolationChecks(root, binding, envelope) {
  const api = globalThis.recordCipher;
  const other = crypto.getRandomValues(new Uint8Array(32));
  check(
    api.openAtRest(other, binding, envelope) === null,
    "foreign device root cannot open record envelope",
  );
  other.fill(0);
  check(
    api.openAtRest(
      root,
      api.atRestBinding(STORE, "customer-b/token"),
      envelope,
    ) === null,
    "record ciphertext cannot move to another customer",
  );
  check(
    api.openAtRest(root, api.atRestBinding("other-purpose", NAME), envelope) ===
      null,
    "record ciphertext cannot move between stores",
  );
  for (const offset of [0, 24, 71, 72, 95, 96]) {
    const packed = globalThis.vaultBytes.b64urlToBytes(envelope.slice(5));
    packed[offset] ^= 1;
    check(
      api.openAtRest(
        root,
        binding,
        `osr2.${globalThis.vaultBytes.bytesToB64url(packed)}`,
      ) === null,
      "record wrap, nonce, and payload corruption fail closed",
    );
  }
  for (const value of [
    "osr2.",
    "osr2.AA",
    "osr9.future",
    envelope.replace("osr2.", "osr1."),
  ]) {
    check(
      api.isSealedAtRest(value) &&
        api.openAtRest(root, binding, value) === null,
      "malformed, unknown, and downgraded records fail closed",
    );
  }
  const collision = api.sealAtRest(
    root,
    api.atRestBinding("customer\u0000a", "token"),
    "collision secret",
  );
  check(
    api.openAtRest(
      root,
      api.atRestBinding("customer", "a\u0000token"),
      collision,
    ) === null,
    "record context framing rejects delimiter collisions",
  );
}

function legacyRecord(root) {
  const nonce = crypto.getRandomValues(new Uint8Array(24));
  const binding = new TextEncoder().encode(
    `opensesame.at-rest.v1\u0000${STORE}\u0000${NAME}`,
  );
  const body = globalThis.recordPrimitives
    .xchacha20poly1305(root, nonce, binding)
    .encrypt(new TextEncoder().encode("legacy record secret"));
  const packed = new Uint8Array(nonce.length + body.length);
  packed.set(nonce);
  packed.set(body, nonce.length);
  return `osr1.${globalThis.vaultBytes.bytesToB64url(packed)}`;
}

export async function verifyRecordAtRestIsolation(mode = "write") {
  const { composeHost, configureHost } = globalThis.recordHost;
  configureHost(
    composeHost(globalThis.browserPortsFactory(), {
      env: { BASE_URL: "/", DEV: false },
    }),
  );
  const root = await globalThis.recordKeys.indexedDbAtRestKeys.load();
  const api = globalThis.recordCipher;
  const binding = api.atRestBinding(STORE, NAME);
  try {
    await wrappingRootChecks(root);
    if (mode === "reload") {
      const fixture = JSON.parse(sessionStorage.getItem(FIXTURE));
      check(
        api.openAtRest(root, binding, localStorage.getItem(RECORD)) ===
          "customer record secret",
        "record envelope survives reload with production wrapped root",
      );
      check(
        api.openAtRest(root, binding, fixture.legacy) ===
          "legacy record secret",
        "legacy record survives reload and unwraps under canonical context",
      );
      sessionStorage.removeItem(FIXTURE);
      localStorage.removeItem(RECORD);
      return [
        "app-core record envelope and legacy wrapped root persistence after browser reload",
      ];
    }
    const envelope = api.sealAtRest(root, binding, "customer record secret");
    const repeat = api.sealAtRest(root, binding, "customer record secret");
    const first = unwrapRecordDataKey(root, binding, envelope);
    const second = unwrapRecordDataKey(root, binding, repeat);
    check(
      first.some((byte, index) => byte !== second[index]),
      "each application record uses a fresh random DEK",
    );
    first.fill(0);
    second.fill(0);
    recordIsolationChecks(root, binding, envelope);
    const legacy = legacyRecord(root);
    check(
      api.openAtRest(root, binding, legacy) === "legacy record secret",
      "legacy record opens through canonical context",
    );
    check(
      api.sealAtRest(root, binding, "legacy record secret").startsWith("osr2."),
      "legacy record rewrite uses envelope encryption",
    );
    localStorage.setItem(RECORD, envelope);
    sessionStorage.setItem(FIXTURE, JSON.stringify({ legacy }));
    return [
      "app-core record random DEKs, wrapped IndexedDB root, customer binding, corruption, and legacy migration",
    ];
  } finally {
    root.fill(0);
  }
}
