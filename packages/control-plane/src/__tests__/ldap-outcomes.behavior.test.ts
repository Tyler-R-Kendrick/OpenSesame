import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createControlPlane } from "../create-app.js";
import { ldapBind } from "../interactions/ldap.js";
import {
  ALICE,
  PEOPLE,
  SERVICE,
  directoryFixture,
} from "./ldap-outcomes.test-support.js";

async function ambiguousSearch() {
  const d = await directoryFixture();
  try {
    const otherDn = `uid=alias,${PEOPLE}`;
    d.server.putEntry({
      dn: otherDn,
      password: d.alicePassword,
      attributes: {
        objectClass: ["inetOrgPerson"],
        uid: ["alice"],
        entryUUID: [randomBytes(16).toString("hex")],
      },
    });
    const { ctx } = createControlPlane();
    expect(await ldapBind(ctx, d.config, "alice", d.alicePassword)).toEqual({
      ok: false,
    });
    expect(d.server.bindAttempts()).toContain(SERVICE);
    expect(d.server.bindAttempts()).not.toContain(ALICE);
    expect(d.server.bindAttempts()).not.toContain(otherDn);
    expect(d.server.removeEntry(otherDn)).toBe(true);
    expect(await ldapBind(ctx, d.config, "alice", d.alicePassword)).toEqual({
      ok: true,
      subject: d.subject,
      groups: [],
    });
    expect(d.server.bindAttempts()).toContain(ALICE);
  } finally {
    await d.server.close();
  }
}

async function stableSubjectRequired() {
  const d = await directoryFixture();
  try {
    const { ctx } = createControlPlane();
    const attributes = { objectClass: ["inetOrgPerson"], uid: ["alice"] };
    d.server.putEntry({ dn: ALICE, password: d.alicePassword, attributes });
    expect(await ldapBind(ctx, d.config, "alice", d.alicePassword)).toEqual({
      ok: false,
    });
    expect(d.server.bindAttempts()).toContain(ALICE);
    d.server.putEntry({
      dn: ALICE,
      password: d.alicePassword,
      attributes: { ...attributes, entryUUID: [d.subject] },
    });
    const restored = await ldapBind(ctx, d.config, "alice", d.alicePassword);
    expect(restored).toEqual({ ok: true, subject: d.subject, groups: [] });
    expect(restored).not.toHaveProperty("subject", ALICE);
  } finally {
    await d.server.close();
  }
}

async function invalidNamesBeforeWire() {
  const d = await directoryFixture();
  try {
    const { ctx } = createControlPlane();
    for (const name of [
      "",
      " ",
      "x".repeat(257),
      "ali\0ce",
      "ali\tce",
      "ali\x7fce",
    ]) {
      expect(await ldapBind(ctx, d.config, name, d.alicePassword)).toEqual({
        ok: false,
      });
    }
    expect(d.server.bindAttempts()).toEqual([]);
    expect(await ldapBind(ctx, d.config, " alice ", d.alicePassword)).toEqual({
      ok: true,
      subject: d.subject,
      groups: [],
    });
    expect(d.server.bindAttempts()).toContain(ALICE);
  } finally {
    await d.server.close();
  }
}

async function literalFilterName() {
  const d = await directoryFixture();
  try {
    const { ctx } = createControlPlane();
    const name = "literal*)(uid=*)";
    const dn = `uid=literal,${PEOPLE}`;
    const password = randomBytes(24).toString("base64url");
    const subject = randomBytes(16).toString("hex");
    d.server.putEntry({
      dn,
      password,
      attributes: {
        objectClass: ["inetOrgPerson"],
        uid: [name],
        entryUUID: [subject],
      },
    });
    expect(await ldapBind(ctx, d.config, name, password)).toEqual({
      ok: true,
      subject,
      groups: [],
    });
    expect(await ldapBind(ctx, d.config, name, d.alicePassword)).toEqual({
      ok: false,
    });
    expect(d.server.bindAttempts()).toContain(dn);
    expect(d.server.bindAttempts()).not.toContain(ALICE);
  } finally {
    await d.server.close();
  }
}

async function literalAndHexNamesStayDistinct() {
  const d = await directoryFixture();
  try {
    const { ctx } = createControlPlane();
    const subjects = [
      randomBytes(16).toString("hex"),
      randomBytes(16).toString("hex"),
    ];
    const passwords = [
      randomBytes(24).toString("base64url"),
      randomBytes(24).toString("base64url"),
    ];
    const names = ["literal*)(uid=*)", "literal\\2a\\29\\28uid=\\2a\\29"];
    const entries = names.map((name, index) => {
      const subject = subjects[index];
      const password = passwords[index];
      if (!subject || !password) throw new Error("fixture credentials missing");
      const dn = `uid=distinct-${index},${PEOPLE}`;
      d.server.putEntry({
        dn,
        password,
        attributes: {
          objectClass: ["inetOrgPerson"],
          uid: [name],
          entryUUID: [subject],
        },
      });
      return { name, dn, password, subject };
    });
    for (const entry of entries) {
      expect(await ldapBind(ctx, d.config, entry.name, entry.password)).toEqual(
        {
          ok: true,
          subject: entry.subject,
          groups: [],
        },
      );
      const other = entries.find((candidate) => candidate.name !== entry.name);
      if (!other) throw new Error("second directory identity missing");
      expect(await ldapBind(ctx, d.config, entry.name, other.password)).toEqual(
        { ok: false },
      );
    }
    expect(d.server.bindAttempts()).not.toContain(ALICE);
    for (const entry of entries)
      expect(d.server.bindAttempts()).toContain(entry.dn);
  } finally {
    await d.server.close();
  }
}

describe("LDAP stable identities and literal wire input", () => {
  it(
    "keeps literal filter syntax and literal backslash-hex usernames as distinct identities on the real wire",
    literalAndHexNamesStayDistinct,
  );
  it(
    "refuses ambiguous search without binding either candidate, then admits the unique stable identity",
    ambiguousSearch,
  );
  it(
    "refuses a successful bind without the configured stable subject rather than falling back to its DN",
    stableSubjectRequired,
  );
  it(
    "refuses invalid usernames before any bind while preserving trimmed valid input",
    invalidNamesBeforeWire,
  );
  it(
    "authenticates a literal filter-shaped username without broadening its search",
    literalFilterName,
  );
});
