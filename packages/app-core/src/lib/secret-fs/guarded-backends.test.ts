import { readdirSync } from "node:fs";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Redacted } from "effect";
import { expect, it } from "vitest";
import { nodeSecretFiles } from "../../node/secret-files.js";
import { SecretFsUnavailable } from "./errors.js";
import type { SecretFiles } from "./files.js";
import { makeMemorySecretFiles } from "./memory.js";
import { resilient } from "./resilient.js";
import { makeS3SecretFiles } from "./s3.js";
import {
  ACCESS_KEY,
  BUCKET_NAME,
  ENDPOINT,
  REGION,
  SECRET_KEY,
  fakeBucket,
} from "./s3.test-support.js";

const bytes = (value: string) => new TextEncoder().encode(value);

it.each(["initial", "before rename"] as const)(
  "directory withdrawal at %s leaves the original file and removes its temporary",
  async (boundary) => {
    const root = await mkdtemp(join(tmpdir(), "guarded-directory-"));
    try {
      const files = await Effect.runPromise(nodeSecretFiles(root));
      await Effect.runPromise(files.write("owned.json", bytes("original")));
      const write = files.writeGuarded;
      if (!write) throw new Error("Missing actual directory guarded writer");
      let sawStaged = false;
      let checks = 0;
      const result = await Effect.runPromiseExit(
        write(
          boundary === "initial" ? "uncreated/owned.json" : "owned.json",
          bytes("replacement"),
          () => {
            checks++;
            sawStaged = readdirSync(root).some((file) =>
              file.endsWith(".part"),
            );
            if (boundary === "initial" || sawStaged)
              throw new Error("Original owner ended");
          },
        ),
      );
      expect(result._tag).toBe("Failure");
      expect(sawStaged).toBe(boundary === "before rename");
      if (boundary === "initial") expect(checks).toBe(1);
      else expect(checks).toBeGreaterThan(1);
      expect(await readFile(join(root, "owned.json"), "utf8")).toBe("original");
      expect(await readdir(root)).toEqual(["owned.json"]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);

it.each(["preflight", "signing"] as const)(
  "S3 withdrawal during %s prevents the actual PUT dispatch",
  async (boundary) => {
    const bucket = fakeBucket(50);
    let live = true;
    let withdraw = false;
    const files = makeS3SecretFiles({
      endpoint: ENDPOINT,
      region: REGION,
      bucket: BUCKET_NAME,
      credentials: {
        accessKeyId: ACCESS_KEY,
        secretAccessKey: Redacted.make(SECRET_KEY),
      },
      now: () => {
        if (withdraw && boundary === "signing") live = false;
        return new Date();
      },
      fetch: async (input, init) => {
        const response = await bucket.fetch(input, init);
        if (withdraw && boundary === "preflight" && init?.method === "GET")
          live = false;
        return response;
      },
    });
    const revision = await Effect.runPromise(
      files.write("owned.json", bytes("original")),
    );
    bucket.log.length = 0;
    withdraw = true;
    const write = files.writeGuarded;
    if (!write) throw new Error("Missing actual S3 guarded writer");
    const result = await Effect.runPromiseExit(
      write(
        "owned.json",
        bytes("replacement"),
        () => {
          if (!live) throw new Error("Original owner ended");
        },
        boundary === "preflight" ? { ifRevision: revision } : undefined,
      ),
    );
    expect(result._tag).toBe("Failure");
    expect(bucket.log.some((entry) => entry.startsWith("PUT "))).toBe(false);
    expect(
      new TextDecoder().decode([...bucket.objects.values()][0]?.bytes),
    ).toBe("original");
  },
);

it.each(["before retry", "during conflict recovery"] as const)(
  "resilience refuses an owner withdrawn %s instead of recovering success",
  async (boundary) => {
    const inner = makeMemorySecretFiles();
    const original = inner.writeGuarded?.bind(inner);
    if (!original) throw new Error("Missing guarded backend fixture");
    let live = true;
    let attempts = 0;
    const files: SecretFiles = {
      ...inner,
      writeGuarded: (path, value, check, options) =>
        Effect.suspend(() => {
          attempts++;
          if (attempts > 1) live = false;
          const write = original(path, value, check, options);
          return attempts === 1
            ? write.pipe(
                Effect.andThen(
                  Effect.suspend(() => {
                    if (boundary === "before retry") live = false;
                    return Effect.fail(
                      new SecretFsUnavailable({
                        path,
                        reason: "valid commit lost its acknowledgement",
                      }),
                    );
                  }),
                ),
              )
            : write;
        }),
    };
    const wrapped = await Effect.runPromise(
      resilient(files, { retries: 2, backoff: "1 millis" }),
    );
    const write = wrapped.writeGuarded;
    if (!write) throw new Error("Resilience lost the guarded writer");
    const result = await Effect.runPromiseExit(
      write(
        "owned.json",
        bytes("accepted while current"),
        () => {
          if (!live) throw new Error("Original owner ended");
        },
        { ifRevision: null },
      ),
    );
    expect(result._tag).toBe("Failure");
    expect(attempts).toBe(boundary === "before retry" ? 1 : 2);
    expect(new TextDecoder().decode(inner.snapshot().get("owned.json"))).toBe(
      "accepted while current",
    );
  },
);
