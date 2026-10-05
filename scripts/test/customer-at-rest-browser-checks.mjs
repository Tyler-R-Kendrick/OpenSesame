const FIXTURE = "customer-at-rest-checks";
const STORE = "customer-browser";
const NAMES = ["customer-a/password", "customer-b/password"];

function check(value, label) {
  if (!value) throw new Error(label);
  return label;
}

function request(operation) {
  return new Promise((resolve, reject) => {
    operation.onsuccess = () => resolve(operation.result);
    operation.onerror = () => reject(operation.error);
  });
}

function bytes(value) {
  return Uint8Array.from(atob(value.slice(5)), (character) =>
    character.charCodeAt(0),
  );
}

function token(packed, prefix = "osc2.") {
  return prefix + btoa(String.fromCharCode(...packed));
}

async function contextRows(api) {
  const db = await request(indexedDB.open(api.CLIENT_AT_REST_DATABASE, 1));
  const rows = await request(
    db.transaction("keys").objectStore("keys").getAll(),
  );
  db.close();
  return rows.filter((row) =>
    NAMES.some(
      (name) =>
        row.id ===
        `envelope:${JSON.stringify(["opensesame.client-envelope.v2", STORE, name])}`,
    ),
  );
}

async function legacyFixture(api) {
  const key = await crypto.subtle.generateKey(
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
  const db = await request(indexedDB.open(api.CLIENT_AT_REST_DATABASE, 1));
  await request(
    db
      .transaction("keys", "readwrite")
      .objectStore("keys")
      .put({ id: "device", key }),
  );
  db.close();
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const sealed = new Uint8Array(
    await crypto.subtle.encrypt(
      {
        name: "AES-GCM",
        iv,
        additionalData: new TextEncoder().encode(
          `opensesame.client-at-rest.v1\u0000${STORE}\u0000legacy`,
        ),
      },
      key,
      new TextEncoder().encode("legacy secret"),
    ),
  );
  const packed = new Uint8Array(iv.length + sealed.length);
  packed.set(iv);
  packed.set(sealed, iv.length);
  return token(packed, "osc1.");
}

async function wrappingChecks(api, first, second) {
  const rows = await contextRows(api);
  check(rows.length === 2, "independent context keys persisted in IndexedDB");
  const unwrap = async (value, name, keyName = name) => {
    const scope = JSON.stringify([
      "opensesame.client-envelope.v2",
      STORE,
      name,
    ]);
    const row = rows.find(
      (candidate) =>
        candidate.id ===
        `envelope:${JSON.stringify(["opensesame.client-envelope.v2", STORE, keyName])}`,
    );
    const packed = bytes(value);
    return new Uint8Array(
      await crypto.subtle.decrypt(
        {
          name: "AES-GCM",
          iv: packed.subarray(0, 12),
          additionalData: new TextEncoder().encode(scope),
        },
        row.key,
        packed.subarray(12, 60),
      ),
    );
  };
  const a = await unwrap(first, NAMES[0]);
  const b = await unwrap(second, NAMES[0]);
  check(
    a.some((value, index) => value !== b[index]),
    "every browser write wraps a fresh DEK",
  );
  let isolated = false;
  try {
    await unwrap(first, NAMES[0], NAMES[1]);
  } catch {
    isolated = true;
  }
  check(isolated, "customer context KEKs are independently generated");
  a.fill(0);
  b.fill(0);
  for (const row of rows) {
    check(
      !row.key.extractable,
      "browser context wrapping keys are non-extractable",
    );
    let refused = false;
    try {
      await crypto.subtle.exportKey("raw", row.key);
    } catch {
      refused = true;
    }
    check(refused, "browser refuses wrapping-key export");
  }
}

export async function verifyBrowserAtRestIsolation(mode = "write") {
  const api = globalThis.browserAtRest;
  if (mode === "reload") {
    const fixture = JSON.parse(sessionStorage.getItem(FIXTURE));
    for (let index = 0; index < NAMES.length; index += 1) {
      check(
        (await api.openFromRest(STORE, NAMES[index], fixture.seals[index])) ===
          `customer-${index}-secret`,
        "IndexedDB customer context key survives browser reload",
      );
    }
    check(
      (await api.openFromRest(STORE, "legacy", fixture.legacy)) ===
        "legacy secret",
      "legacy device key remains readable after reload",
    );
    sessionStorage.removeItem(FIXTURE);
    return ["browser envelope reload and legacy key persistence"];
  }
  await api.sealForRest("fixture-schema", "initialize", "empty");
  const legacy = await legacyFixture(api);
  const seals = await Promise.all(
    NAMES.map((name, index) =>
      api.sealForRest(STORE, name, `customer-${index}-secret`),
    ),
  );
  const repeat = await api.sealForRest(STORE, NAMES[0], "customer-0-secret");
  await wrappingChecks(api, seals[0], repeat);
  check(
    (await api.openFromRest(STORE, NAMES[1], seals[0])) === null,
    "foreign customer browser envelope refused",
  );
  for (const offset of [0, 12, 59, 60, 72, bytes(seals[0]).length - 1]) {
    const packed = bytes(seals[0]);
    packed[offset] ^= 1;
    check(
      (await api.openFromRest(STORE, NAMES[0], token(packed))) === null,
      "tampered wrapping key or payload refused",
    );
  }
  check(
    (await api.openFromRest(STORE, NAMES[0], "osc2.AA==")) === null,
    "malformed envelope refused",
  );
  check(
    (await api.openFromRest(
      STORE,
      NAMES[0],
      seals[0].replace("osc2.", "osc1."),
    )) === null,
    "browser envelope downgrade refused",
  );
  check(
    (await api.openFromRest(STORE, NAMES[0], "osc9.future")) === null,
    "unknown browser envelope version refused",
  );
  check(
    (await api.openFromRest(STORE, "legacy", legacy)) === "legacy secret",
    "legacy osc1 fixture opens",
  );
  check(
    (await api.sealForRest(STORE, "legacy", "legacy secret")).startsWith(
      "osc2.",
    ),
    "legacy rewrites use envelope format",
  );
  sessionStorage.setItem(FIXTURE, JSON.stringify({ seals, legacy }));
  return [
    "fresh DEKs, non-extractable independent context KEKs, tampering, downgrade and legacy reads",
  ];
}
