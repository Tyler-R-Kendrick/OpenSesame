// Nothing the app stores rests in the clear (ADR 0148), measured in the real
// browser: every value of the app's Web Storage keys, every one of its
// origin-private files and every row of its IndexedDB databases is an
// at-rest seal, the key that opens them cannot be exported, and none of the
// given plaintexts appears anywhere a value rests.

/** App-owned Web Storage keys (`lib/storage-ownership.ts`). */
const OWNED_PREFIXES = [
  "opensesame.",
  "opensesame:federation:",
  "opensesame:ambient-auth:",
];
const OWNED_KEYS = [
  "opensesame:org-profile",
  "join.presented.v1",
  "join.pending.v2",
  "join.invite.v1",
];

/**
 * @param {import("playwright").Page} page
 * @param {(ok: boolean, detail: string) => void} check
 * @param {string[]} plaintexts regex sources that must match no stored value
 */
export async function checkNothingInTheClear(page, check, plaintexts = []) {
  const found = await page.evaluate(
    async ({ prefixes, keys, needles }) => {
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
      const root = await navigator.storage.getDirectory();
      for await (const [name, handle] of root.entries()) {
        if (!name.startsWith("opensesame-pages-")) continue;
        values.push({
          where: `file:${name}`,
          text: await (await handle.getFile()).text(),
        });
      }
      const databases = await indexedDB.databases();
      const open = (name) =>
        new Promise((resolve, reject) => {
          const req = indexedDB.open(name);
          req.onsuccess = () => resolve(req.result);
          req.onerror = () => reject(req.error);
        });
      const all = (db, store) =>
        new Promise((resolve, reject) => {
          const req = db.transaction(store).objectStore(store).getAll();
          req.onsuccess = () => resolve(req.result);
          req.onerror = () => reject(req.error);
        });
      let keyExtractable = null;
      const unsealedRows = [];
      for (const { name } of databases) {
        if (!name?.startsWith("opensesame-")) continue;
        const db = await open(name);
        for (const store of db.objectStoreNames) {
          for (const row of await all(db, store)) {
            if (name === "opensesame-at-rest") {
              keyExtractable = row.wrappingKey?.extractable ?? null;
            } else if (typeof row.sealed !== "string") {
              unsealedRows.push(`${name}/${store}/${row.id}`);
            } else {
              values.push({ where: `idb:${name}/${store}`, text: row.sealed });
            }
          }
        }
        db.close();
      }
      return {
        count: values.length,
        clear: values
          .filter(({ text }) => !String(text).startsWith("osr1."))
          .map(({ where }) => where),
        leaked: values
          .filter(({ text }) =>
            needles.some((needle) => new RegExp(needle).test(String(text))),
          )
          .map(({ where }) => where),
        keyExtractable,
        unsealedRows,
      };
    },
    { prefixes: OWNED_PREFIXES, keys: OWNED_KEYS, needles: plaintexts },
  );
  check(found.count > 0, `the app stored something to check (${found.count})`);
  check(
    found.clear.length === 0,
    `every stored value is sealed ${found.clear.join(", ")}`,
  );
  check(
    found.unsealedRows.length === 0,
    `every IndexedDB row is sealed ${found.unsealedRows.join(", ")}`,
  );
  check(
    found.leaked.length === 0,
    `no plaintext rests anywhere ${found.leaked.join(", ")}`,
  );
  check(
    found.keyExtractable === false,
    "the at-rest key is kept and cannot be exported",
  );
}
