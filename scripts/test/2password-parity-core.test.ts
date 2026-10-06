import { describe, expect, it } from "vitest";
import {
  audit,
  find,
  inventory,
} from "../../packages/app-core/src/lib/password-agent/discover.js";
import {
  parseAssignment,
  read,
  renderEnv,
  resolveEnv,
  run,
} from "../../packages/app-core/src/lib/password-agent/env.js";
import type {
  InvokeOptions,
  PasswordAgentPort,
} from "../../packages/app-core/src/lib/password-agent/transport.js";

const sentinel = "FICTIONAL-SECRET-NEVER-IN-OUTPUT";
function item(
  index: number,
  title: string,
  category = "API_CREDENTIAL",
  vault = "Work",
) {
  const id = String(index).padStart(26, "a");
  return {
    id,
    title,
    category,
    vault: { name: vault },
    tags: ["z", "a"],
    urls: [
      {
        href: `https://user:${sentinel}@example.test/oauth/callback?token=${sentinel}#${sentinel}`,
      },
    ],
    created_at: "2019-01-01T00:00:00Z",
    updated_at: "2020-01-01T00:00:00Z",
    fields: [
      {
        id: "credential",
        label: "Key",
        type: "CONCEALED",
        reference: `op://${vault}/${id}/credential`,
        value: sentinel,
      },
      {
        id: "password",
        type: "STRING",
        purpose: "PASSWORD",
        section: { label: "Imported" },
        reference: `op://${vault}/${id}/password`,
        value: sentinel,
      },
      {
        id: "username",
        type: "STRING",
        reference: `op://${vault}/${id}/username`,
        value: sentinel,
      },
    ],
  };
}
function provider(items: ReturnType<typeof item>[]) {
  const calls: { args: readonly string[]; options: InvokeOptions }[] = [];
  const port: PasswordAgentPort = {
    async invoke(args, options) {
      calls.push({ args, options });
      if (args[1] === "list")
        return JSON.stringify(items.map(({ fields, ...summary }) => summary));
      expect(args.slice(0, 3)).toEqual(["item", "get", "-"]);
      // SAFETY: the core writes a JSON array of the fixture summaries, each with a string id.
      const selected = JSON.parse(options.input ?? "[]") as { id: string }[];
      return items
        .filter((entry) => selected.some(({ id }) => id === entry.id))
        .map((entry) => JSON.stringify(entry))
        .join("\n");
    },
  };
  return { port, calls };
}

describe("2password parity core", () => {
  it("read.explicit", async () => {
    const calls: string[][] = [];
    const port: PasswordAgentPort = {
      async invoke(args) {
        calls.push([...args]);
        return sentinel;
      },
    };
    expect(await read(port, "op://Work/Key/credential")).toBe(sentinel);
    expect(calls).toEqual([["read", "op://Work/Key/credential"]]);
    await expect(read(port, "plaintext")).rejects.toThrow();
    expect(calls).toHaveLength(1);
  });
  it("find.multiquery", async () => {
    const fake = provider([
      item(1, "OpenAI API Key"),
      item(2, "Stripe Key"),
      item(3, "OpenAI unrelated"),
    ]);
    const result = await find(fake.port, ["OPENAI API", "key", "key"], {
      vault: "Work",
      account: "account",
    });
    expect(result.matches).toHaveLength(4);
    expect(
      result.matches.filter((entry) => entry.title.startsWith("OpenAI")),
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ queries: ["OPENAI API", "key"] }),
      ]),
    );
    expect(fake.calls).toHaveLength(2);
    expect(fake.calls[0]?.args).toContain("Work");
    expect(fake.calls.every((call) => call.options.account === "account")).toBe(
      true,
    );
    expect(JSON.stringify(fake.calls[1]?.options.input)).not.toContain(
      item(3, "OpenAI unrelated").id,
    );
    expect(
      (await find(fake.port, ["stripe", "stripe"])).matches.every(
        (entry) => !("queries" in entry),
      ),
    ).toBe(true);
  });
  it("find.suggestions", async () => {
    const fake = provider([
      item(1, "Database Key"),
      item(2, "Database Backup"),
      item(3, "Database Admin"),
      item(4, "Database Fourth"),
      item(5, "Zebra"),
    ]);
    const result = await find(fake.port, ["databse"]);
    expect(result.matches).toEqual([]);
    expect(new Set(result.suggestions?.map((entry) => entry.title)).size).toBe(
      3,
    );
    expect(
      result.suggestions?.every((entry) => entry.query === "databse"),
    ).toBe(true);
    expect(fake.calls).toHaveLength(2);
    expect(JSON.parse(fake.calls[1]?.options.input ?? "[]")).toHaveLength(3);
  });
  it("find.concealed", async () => {
    const fake = provider([item(2, "Key B"), item(1, "Key A")]);
    const result = await find(fake.port, ["key"]);
    expect(result.matches).toHaveLength(4);
    expect(result.matches.some((entry) => entry.ref.endsWith("username"))).toBe(
      false,
    );
    expect(result.matches.map((entry) => entry.ref)).toEqual(
      result.matches.map((entry) => entry.ref).sort(),
    );
    expect(JSON.stringify(result)).not.toContain(sentinel);
  });
  it("inventory.safe-metadata", async () => {
    const fake = provider([item(1, "Key")]);
    const result = await inventory(fake.port);
    expect(result[0]?.urls).toEqual(["https://example.test"]);
    expect(result[0]?.fields[1]).toEqual(
      expect.objectContaining({
        label: "password",
        type: "string",
        purpose: "password",
        section: "Imported",
      }),
    );
    expect(JSON.stringify(result)).not.toContain(sentinel);
    expect(fake.calls).toHaveLength(2);
  });
  it("inventory.ordering", async () => {
    const fake = provider([
      item(1, "B", "LOGIN", "Z"),
      item(2, "B", "LOGIN", "A"),
      item(3, "A", "LOGIN", "A"),
    ]);
    const result = await inventory(fake.port);
    expect(result.map((entry) => `${entry.vault}/${entry.title}`)).toEqual([
      "A/A",
      "A/B",
      "Z/B",
    ]);
    expect(result.every((entry) => entry.tags.join() === "a,z")).toBe(true);
  });
  it("audit.duplicates", async () => {
    const fake = provider([
      item(1, "Same"),
      item(2, "SAME", "LOGIN", "Personal"),
    ]);
    expect((await audit(fake.port)).duplicateTitles[0]?.items).toHaveLength(2);
    expect(fake.calls).toHaveLength(2);
  });
  it("audit.machine", async () => {
    const kinds = [
      "API_CREDENTIAL",
      "DATABASE",
      "DOCUMENT",
      "PASSWORD",
      "SECURE_NOTE",
      "SSH_KEY",
      "LOGIN",
    ];
    const items = kinds.map((kind, index) => ({
      ...item(index, kind, kind),
      tags: [],
    }));
    const fake = provider(items);
    const result = await audit(fake.port);
    expect(result.untaggedMachineCredentials).toHaveLength(6);
    expect(result.summary).toEqual({ items: 7, tagged: 0, untagged: 7 });
    expect(JSON.stringify(result)).not.toContain(sentinel);
  });
  it("audit.old-logins", async () => {
    const fake = provider([
      item(1, "Old", "LOGIN"),
      { ...item(2, "New", "LOGIN"), updated_at: "2026-01-01T00:00:00Z" },
      item(3, "Machine"),
    ]);
    expect(
      (
        await audit(fake.port, {}, new Date("2026-10-05T00:00:00Z"))
      ).oldLogins.map((entry) => entry.title),
    ).toEqual(["Old"]);
  });
  it("audit.transient-urls", async () => {
    const fake = provider([item(1, "Key")]);
    const result = await audit(fake.port);
    expect(result.urlsToReview[0]?.urls).toEqual(["https://example.test"]);
    expect(result.urlsToReview[0]?.reason).toBe("transient-url");
    expect(JSON.stringify(result)).not.toContain(sentinel);
  });
  it("inventory.origin-only", async () => {
    const raw = item(1, "Path token");
    raw.urls = [
      {
        href: `https://user:${sentinel}@example.test/reset/${sentinel}?token=${sentinel}#${sentinel}`,
      },
      { href: `https://example.test/account/${sentinel}` },
      { href: `http://example.test/${sentinel}` },
      { href: `relative/reset/${sentinel}` },
      { href: `javascript:${sentinel}` },
      { href: `file:///reset/${sentinel}` },
      { href: `data:text/plain,${sentinel}` },
    ];
    const result = await inventory(provider([raw]).port);
    expect(result[0]?.urls).toEqual([
      "https://example.test",
      "http://example.test",
    ]);
    expect(result[0]?.urlsNeedReview).toBe(true);
    const report = await audit(provider([raw]).port);
    expect(report.urlsToReview).toEqual([
      {
        id: raw.id,
        title: raw.title,
        urls: ["https://example.test", "http://example.test"],
        reason: "transient-url",
      },
    ]);
    expect(JSON.stringify({ result, report })).not.toContain(sentinel);
  });
  it("env.write", () => {
    const assignment = parseAssignment("KEY=op://Work/Key/credential");
    expect(renderEnv([assignment])).toBe("KEY=op://Work/Key/credential\n");
    for (const invalid of [
      "KEY=plaintext",
      "1KEY=op://Work/Key/credential",
      "KEY",
      "=op://x",
    ])
      expect(() => parseAssignment(invalid)).toThrow();
  });
  it("env.resolve", async () => {
    const calls: string[][] = [];
    const result = await resolveEnv(
      "# Development\nexport A='op://Work/Key/credential'\nB=op://Work/Key/credential\nPLAIN=safe\n",
      async (refs) => {
        calls.push([...refs]);
        return ['quote"slash\\line\nreturn\r\n'];
      },
    );
    expect(calls).toEqual([["op://Work/Key/credential"]]);
    expect(result.count).toBe(2);
    expect(result.content).toBe(
      '# Development\nA="quote\\"slash\\\\line\\nreturn\\r"\nB="quote\\"slash\\\\line\\nreturn\\r"\nPLAIN=safe\n',
    );
    await expect(resolveEnv("A=op://x", async () => [])).rejects.toThrow(
      "invalid batch",
    );
  });
  it("run.execute", async () => {
    const calls: unknown[] = [];
    const port: PasswordAgentPort = {
      invoke: async () => "",
      run: async (...args) => {
        calls.push(args);
        return 17;
      },
    };
    expect(
      await run(
        port,
        [parseAssignment("KEY=op://Work/Key/credential")],
        ["consumer", "--flag", "value with spaces"],
      ),
    ).toBe(17);
    expect(calls).toEqual([
      [
        ["run"],
        ["consumer", "--flag", "value with spaces"],
        { KEY: "op://Work/Key/credential" },
      ],
    ]);
  });
});
