import { Effect } from "effect";
import { afterEach, expect, it } from "vitest";
import { bucket, data, failure } from "./test/s3-response-fixtures.js";

const opened: Awaited<ReturnType<typeof bucket>>[] = [];
afterEach(async () => {
  for (const fixture of opened.splice(0)) await fixture.close();
});
const xml = (value: string) =>
  value.replaceAll("&", "&amp;").replaceAll("<", "&lt;");

it.each([
  "",
  "/",
  "//nested///",
  "/leading/",
  "space %/?#é/雪//",
  "plain-prefix",
  "%2e%2e/%2F../",
])(
  "preserves literal prefix %j across actual PUT, GET and logical listing",
  async (prefix) => {
    const bytes = data("sealed ciphertext");
    const fixture = await bucket({
      respond: (row) => {
        const url = new URL(row.path, "http://localhost");
        if (url.searchParams.has("list-type"))
          return {
            chunks: [
              data(
                `<ListBucketResult><IsTruncated>false</IsTruncated><Contents><Key>${xml(prefix)}a</Key></Contents></ListBucketResult>`,
              ),
            ],
          };
        return row.method === "PUT" ? {} : { chunks: [bytes] };
      },
    });
    opened.push(fixture);
    const files = fixture.files({
      prefix,
      prefixMode: "literal",
      maxBytes: 2048,
    });
    await Effect.runPromise(files.write("a", bytes, { ifRevision: null }));
    expect((await Effect.runPromise(files.read("a"))).bytes).toEqual(bytes);
    expect(await Effect.runPromise(files.list(""))).toEqual(["a"]);
    expect(fixture.rows).toHaveLength(3);
    for (const row of fixture.rows.slice(0, 2)) {
      const target = new URL(row.path, "http://localhost");
      expect(target.pathname).toBe(
        `/vault-bucket/${prefix.split("/").map(encodeURIComponent).join("/")}a`,
      );
      expect(
        decodeURIComponent(target.pathname.slice("/vault-bucket/".length)),
      ).toBe(`${prefix}a`);
      expect(target.search).toBe("");
      expect(target.hash).toBe("");
    }
    expect(fixture.rows[0]?.none).toBe("*");
    const list = new URL(fixture.rows[2]?.path ?? "", "http://localhost");
    expect(list.pathname).toBe("/vault-bucket/");
    expect(list.searchParams.get("prefix")).toBe(prefix);
  },
);

it.each(["../outside/", "safe/../escape", "./", "safe/./child", ".."])(
  "rejects literal dot traversal %j before any request",
  async (prefix) => {
    const fixture = await bucket([]);
    opened.push(fixture);
    expect(() => fixture.files({ prefix, prefixMode: "literal" })).toThrow(
      "dot segments",
    );
    expect(fixture.rows).toEqual([]);
  },
);

it("preserves default directory normalization and keeps literal conditional conflicts non-clobbering", async () => {
  const bytes = data("existing ciphertext");
  const fixture = await bucket([
    { chunks: [bytes] },
    { status: 412 },
    { chunks: [bytes] },
  ]);
  opened.push(fixture);
  await Effect.runPromise(fixture.files({ prefix: "/legacy//dir/" }).read("a"));
  expect(fixture.rows[0]?.path).toBe("/vault-bucket/legacy//dir/a");
  const error = await failure(
    fixture
      .files({ prefix: "/literal%/", prefixMode: "literal" })
      .write("a", data("replacement"), { ifRevision: null }),
  );
  expect(error._tag).toBe("SecretFsConflict");
  expect(fixture.rows[1]).toMatchObject({
    method: "PUT",
    path: "/vault-bucket//literal%25/a",
    none: "*",
  });
  expect(fixture.rows[2]?.path).toBe("/vault-bucket//literal%25/a");
});
