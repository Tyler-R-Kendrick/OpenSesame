// Nothing the app stores rests in the clear (ADR 0149), measured in the real
// browser: every value of the app's Web Storage keys, every one of its
// origin-private files and every row of its IndexedDB databases (a row's
// `sealed` field, or the whole row when it has none) is an at-rest seal,
// the key that opens them cannot be exported, and none of the given
// plaintexts appears anywhere a value rests.

/** App-owned Web Storage keys (`lib/storage-ownership.ts`). */
const OWNED = {
  prefixes: [
    "opensesame.",
    "opensesame:federation:",
    "opensesame:ambient-auth:",
  ],
  keys: [
    "opensesame:org-profile",
    "join.presented.v1",
    "join.pending.v2",
    "join.invite.v1",
  ],
};

function webStorageValues(page) {
  return page.evaluate(({ prefixes, keys }) => {
    const owned = (key) =>
      keys.includes(key) || prefixes.some((p) => key.startsWith(p));
    const values = [];
    for (const [area, store] of [
      ["local", localStorage],
      ["session", sessionStorage],
    ]) {
      for (let i = 0; i < store.length; i += 1) {
        const key = store.key(i) ?? "";
        if (owned(key)) {
          values.push({ where: `${area}:${key}`, text: store.getItem(key) });
        }
      }
    }
    return values;
  }, OWNED);
}

function originFileValues(page) {
  return page.evaluate(async () => {
    const values = [];
    const root = await navigator.storage.getDirectory();
    for await (const [name, handle] of root.entries()) {
      if (name.startsWith("opensesame-pages-")) {
        const text = await (await handle.getFile()).text();
        values.push({ where: `file:${name}`, text });
      }
    }
    return values;
  });
}

function indexedDbValues(page) {
  return page.evaluate(async () => {
    const settle = (req) =>
      new Promise((resolve, reject) => {
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      });
    const values = [];
    let keyExtractable = null;
    for (const { name } of await indexedDB.databases()) {
      if (!name?.startsWith("opensesame-")) continue;
      const db = await settle(indexedDB.open(name));
      for (const store of db.objectStoreNames) {
        const rows = await settle(
          db.transaction(store).objectStore(store).getAll(),
        );
        for (const row of rows) {
          if (name === "opensesame-at-rest") {
            keyExtractable = row.wrappingKey?.extractable ?? null;
            continue;
          }
          const text = String(row.sealed ?? JSON.stringify(row));
          values.push({ where: `idb:${name}/${store}/${row.id}`, text });
        }
      }
      db.close();
    }
    return { values, keyExtractable };
  });
}

/**
 * @param {import("playwright").Page} page
 * @param {(ok: boolean, detail: string) => void} check
 * @param {string[]} plaintexts regex sources that must match no stored value
 * @param {string[]} present places (`local:<key>`, `file:<name>`) that must
 *   hold a value, so a check cannot pass by finding nothing there
 */
export async function checkNothingInTheClear(
  page,
  check,
  plaintexts = [],
  present = [],
) {
  const idb = await indexedDbValues(page);
  const values = [
    ...(await webStorageValues(page)),
    ...(await originFileValues(page)),
    ...idb.values,
  ];
  const where = (list) => list.map((value) => value.where).join(", ");
  const clear = values.filter(({ text }) => !String(text).startsWith("osr1."));
  const leaked = values.filter(({ text }) =>
    plaintexts.some((needle) => new RegExp(needle).test(String(text))),
  );
  check(values.length > 0, `the app stored something (${values.length})`);
  for (const place of present) {
    check(
      values.some((value) => value.where === place),
      `${place} is stored`,
    );
  }
  check(clear.length === 0, `every stored value is sealed ${where(clear)}`);
  check(leaked.length === 0, `no plaintext rests anywhere ${where(leaked)}`);
  check(
    idb.keyExtractable === false,
    "the at-rest key is kept and cannot be exported",
  );
}
