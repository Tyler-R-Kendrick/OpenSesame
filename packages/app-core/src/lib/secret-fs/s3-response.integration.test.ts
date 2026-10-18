import { Effect } from "effect";
import { afterEach, describe, expect, it } from "vitest";
import { revisionOf } from "./files.js";
import {
  TEST_KEY,
  bucket,
  data,
  failure,
  gate,
} from "./s3-response.test-support.js";
import type { Plan, Row } from "./s3-response.test-support.js";

const opened: Array<Awaited<ReturnType<typeof bucket>>> = [];
async function fixture(plans: Parameters<typeof bucket>[0]) {
  const value = await bucket(plans);
  opened.push(value);
  return value;
}
async function physicallyClosed(row: Row | undefined) {
  if (!row) throw new Error("expected actual owned HTTP exchange");
  await row.closed.promise;
  await row.socketClosed.promise;
}
afterEach(async () => {
  for (const value of opened.splice(0)) await value.close();
});

describe("S3 bounded native response lifetime", () => {
  it("reads exact-cap chunked binary through real EOF and preserves revision", async () => {
    const bytes = new Uint8Array([0, 255, 37, 128, 65, 0, 10, 42]);
    const server = await fixture([
      { chunks: [bytes.slice(0, 3), bytes.slice(3)], etag: '"untrusted"' },
    ]);
    const signals: AbortSignal[] = [];
    const send: typeof fetch = (input, init) => {
      if (init?.signal) signals.push(init.signal);
      return fetch(input, init);
    };
    const result = await Effect.runPromise(
      server.files({ maxBytes: 8, fetch: send }).read("a"),
    );
    expect(result).toEqual({ bytes, revision: revisionOf(bytes) });
    expect(signals).toHaveLength(1);
    expect(signals[0]?.aborted).toBe(false);
    await physicallyClosed(server.rows[0]);
    expect(server.rows[0]).toMatchObject({
      finished: true,
      premature: false,
      sent: 8,
    });
  });

  it.each([
    ["chunked", { chunks: [data("1234"), data("56789")], hold: gate<void>() }],
    ["declared", { declared: "9", hold: gate<void>() }],
    ["truncated", { declared: "8", chunks: [data("12")], truncate: true }],
  ] satisfies Array<[string, Plan]>)(
    "rejects %s overflow/truncation and closes actual I/O",
    async (_name, plan) => {
      const server = await fixture([plan]);
      const error = await failure(server.files({ maxBytes: 8 }).read("a"));
      expect(error._tag).toBe("SecretFsUnavailable");
      await physicallyClosed(server.rows[0]);
      expect(server.rows[0]?.premature).toBe(true);
      expect(JSON.stringify(error)).not.toContain(TEST_KEY);
    },
  );

  it.each(["PUT", "DELETE"])(
    "drains a delayed %s success body to EOF",
    async (method) => {
      const hold = gate<void>();
      const server = await fixture([{ chunks: [data("ok")], hold }]);
      const files = server.files();
      const operation = Effect.runPromise(
        method === "PUT" ? files.write("a", data("sealed")) : files.remove("a"),
      );
      const row = await server.next();
      await row.written.promise;
      expect(row.finished).toBe(false);
      hold.resolve();
      await operation;
      await physicallyClosed(row);
      expect(row).toMatchObject({
        method,
        finished: true,
        premature: false,
        sent: 2,
      });
      expect(row.body).toEqual(
        method === "PUT" ? data("sealed") : new Uint8Array(),
      );
    },
  );

  it.each(["PUT", "DELETE"])(
    "accepts an ordinary empty %s success",
    async (method) => {
      const server = await fixture([
        { status: method === "DELETE" ? 204 : 200 },
      ]);
      const files = server.files();
      await Effect.runPromise(
        method === "PUT" ? files.write("a", data("sealed")) : files.remove("a"),
      );
      await physicallyClosed(server.rows[0]);
      expect(server.rows[0]).toMatchObject({
        finished: true,
        premature: false,
      });
    },
  );

  it("bounds unexpected successful write bodies independently of file capacity", async () => {
    const server = await fixture([
      { chunks: [new Uint8Array(4097)], hold: gate<void>() },
    ]);
    const error = await failure(server.files().write("a", data("sealed")));
    expect(error._tag).toBe("SecretFsUnavailable");
    await physicallyClosed(server.rows[0]);
    expect(server.rows[0]?.premature).toBe(true);
  });

  it.each(["effect", "owner"])(
    "aborts a held real GET on %s withdrawal",
    async (kind) => {
      const controller = new AbortController();
      const server = await fixture([
        { chunks: [data("partial")], hold: gate<void>() },
      ]);
      const files = server.files(
        kind === "owner" ? { signal: controller.signal } : {},
      );
      const result = Effect.runPromise(
        files.read("a"),
        kind === "effect" ? { signal: controller.signal } : undefined,
      );
      const failed = result.then(
        () => false,
        () => true,
      );
      const row = await server.next();
      await row.written.promise;
      controller.abort();
      expect(await failed).toBe(true);
      await physicallyClosed(row);
      expect(row).toMatchObject({ premature: true, finished: false });
    },
  );

  it("withdraws the captured check during a real chunked body without late bytes", async () => {
    const next = gate<void>();
    const server = await fixture([
      {
        chunks: [data("one"), data("two")],
        beforeNext: next,
        hold: gate<void>(),
      },
    ]);
    let current = true;
    const result = failure(
      server
        .files({
          assertCurrent: () => {
            if (!current) throw new Error(TEST_KEY);
          },
        })
        .read("a"),
    );
    const row = await server.next();
    await row.written.promise;
    current = false;
    next.resolve();
    const error = await result;
    expect(error._tag).toBe("SecretFsRejected");
    expect(JSON.stringify(error)).not.toContain(TEST_KEY);
    await physicallyClosed(row);
    expect(row.premature).toBe(true);
  });

  it.each(["signal", "check"])(
    "already-withdrawn %s sends zero requests",
    async (kind) => {
      const owner = new AbortController();
      owner.abort();
      const server = await fixture([]);
      const config =
        kind === "signal"
          ? { signal: owner.signal }
          : {
              assertCurrent: () => {
                throw new Error(TEST_KEY);
              },
            };
      expect((await failure(server.files(config).read("a")))._tag).toBe(
        "SecretFsRejected",
      );
      expect(server.rows).toEqual([]);
    },
  );

  it("checks ownership after the actual reader has reached EOF and released", async () => {
    const server = await fixture([{ chunks: [data("whole")] }]);
    let body: ReadableStream<Uint8Array> | null = null;
    let observedLocked = false;
    const send: typeof fetch = async (input, init) => {
      const response = await fetch(input, init);
      body = response.body;
      return response;
    };
    const check = () => {
      if (body?.locked) observedLocked = true;
      if (observedLocked && body?.locked === false) throw new Error(TEST_KEY);
    };
    const error = await failure(
      server.files({ fetch: send, assertCurrent: check }).read("a"),
    );
    expect(error._tag).toBe("SecretFsRejected");
    expect(observedLocked).toBe(true);
    await physicallyClosed(server.rows[0]);
    expect(server.rows[0]).toMatchObject({ finished: true, premature: false });
  });

  it.each([403, 404])(
    "cancels a held %s refusal without reading its private body",
    async (status) => {
      const server = await fixture([
        { status, chunks: [data("provider-private-body")], hold: gate<void>() },
      ]);
      const error = await failure(server.files().read("a"));
      expect(error._tag).toBe(
        status === 403 ? "SecretFsRejected" : "SecretFsNotFound",
      );
      expect(JSON.stringify(error)).not.toContain("provider-private-body");
      await physicallyClosed(server.rows[0]);
      expect(server.rows[0]?.premature).toBe(true);
    },
  );

  it.each([409, 412])(
    "closes held conditional %s before diagnostic GET",
    async (status) => {
      let previous: Row | undefined;
      const server = await fixture({
        respond: (row) => {
          if (row.method === "PUT") {
            previous = row;
            return { status, hold: gate<void>() };
          }
          expect(previous?.premature).toBe(true);
          return { chunks: [data("rival")], etag: '"other"' };
        },
      });
      const error = await failure(
        server.files().write("a", data("mine"), { ifRevision: null }),
      );
      expect(error).toMatchObject({
        _tag: "SecretFsConflict",
        actual: revisionOf(data("rival")),
      });
      expect(server.rows.map((row) => row.method)).toEqual(["PUT", "GET"]);
      expect(server.rows[0]?.none).toBe("*");
      await Promise.all(server.rows.map(physicallyClosed));
    },
  );

  it("closes currentOf404 before reporting conflict and never sends PUT", async () => {
    const server = await fixture([{ status: 404, hold: gate<void>() }]);
    expect(
      (
        await failure(
          server.files().write("a", data("new"), { ifRevision: "stale" }),
        )
      )._tag,
    ).toBe("SecretFsConflict");
    await physicallyClosed(server.rows[0]);
    expect(server.rows[0]?.premature).toBe(true);
    expect(server.rows.map((row) => row.method)).toEqual(["GET"]);
  });

  it("preserves actual If-Match conditional writes after revision inspection", async () => {
    const server = await fixture([
      { chunks: [data("old")], etag: '"bucket-etag"' },
      {},
    ]);
    const next = data("new");
    expect(
      await Effect.runPromise(
        server
          .files()
          .write("a", next, { ifRevision: revisionOf(data("old")) }),
      ),
    ).toBe(revisionOf(next));
    expect(server.rows.map((row) => row.method)).toEqual(["GET", "PUT"]);
    expect(server.rows[1]?.match).toBe('"bucket-etag"');
    await Promise.all(server.rows.map(physicallyClosed));
  });

  it.each(["revision", "listing"])(
    "withdraws between %s exchanges without next authenticated I/O",
    async (kind) => {
      let current = true;
      const xml =
        "<ListBucketResult><Contents><Key>a</Key></Contents><IsTruncated>true</IsTruncated><NextContinuationToken>next</NextContinuationToken></ListBucketResult>";
      const server = await fixture([
        {
          chunks: [data(kind === "listing" ? xml : "old")],
          finished: () => {
            current = false;
          },
        },
      ]);
      const files = server.files({
        maxBytes: 512,
        assertCurrent: () => {
          if (!current) throw new Error(TEST_KEY);
        },
      });
      const error =
        kind === "listing"
          ? await failure(files.list(""))
          : await failure(
              files.write("a", data("new"), {
                ifRevision: revisionOf(data("old")),
              }),
            );
      expect(error._tag).toBe("SecretFsRejected");
      await physicallyClosed(server.rows[0]);
      expect(server.rows).toHaveLength(1);
    },
  );

  it("lets actual conditional creates choose one winner without overwriting it", async () => {
    let stored: Uint8Array | null = null;
    const server = await fixture({
      respond: (row) => {
        if (row.method === "GET")
          return { chunks: stored ? [stored] : [], status: stored ? 200 : 404 };
        if (row.none === "*" && stored !== null) return { status: 412 };
        stored = row.body.slice();
        return {};
      },
    });
    const files = server.files();
    const results = await Promise.allSettled(
      ["first", "second"].map((text) =>
        Effect.runPromise(files.write("a", data(text), { ifRevision: null })),
      ),
    );
    expect(
      results.filter((result) => result.status === "fulfilled"),
    ).toHaveLength(1);
    expect(
      results.filter((result) => result.status === "rejected"),
    ).toHaveLength(1);
    expect(["first", "second"]).toContain(
      new TextDecoder().decode(stored ?? new Uint8Array()),
    );
    expect(
      server.rows
        .filter((row) => row.method === "PUT")
        .every((row) => row.none === "*"),
    ).toBe(true);
    await Promise.all(server.rows.map(physicallyClosed));
  });

  it.each([
    0,
    -1,
    1.5,
    Number.NaN,
    Number.POSITIVE_INFINITY,
    Number.MAX_SAFE_INTEGER + 1,
  ])("rejects invalid configured bound %s before I/O", async (maxBytes) => {
    const server = await fixture([]);
    expect(() => server.files({ maxBytes })).toThrow(/positive safe integer/);
    expect(server.rows).toEqual([]);
  });
});
