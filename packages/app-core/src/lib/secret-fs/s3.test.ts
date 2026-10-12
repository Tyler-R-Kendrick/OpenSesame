import { Duration, Effect, Redacted } from "effect";
import { describe, expect, it } from "vitest";
import { describeSecretFiles, failureOf } from "./files.conformance.js";
import { resilient } from "./resilient.js";
import { makeS3SecretFiles } from "./s3.js";
import type { S3FilesConfig } from "./s3.js";
import {
  ACCESS_KEY,
  BUCKET_NAME,
  ENDPOINT,
  REGION,
  SECRET_KEY,
  fakeBucket,
} from "./s3.test-support.js";

const bytes = (text: string) => new TextEncoder().encode(text);

type Setup = Pick<S3FilesConfig, "prefix" | "addressing"> & {
  secret?: string;
  fetch?: typeof fetch;
};
const NONE: Setup = {};

function client(bucket: ReturnType<typeof fakeBucket>, setup: Setup = NONE) {
  return makeS3SecretFiles({
    endpoint: ENDPOINT,
    region: REGION,
    bucket: BUCKET_NAME,
    prefix: setup.prefix,
    credentials: {
      accessKeyId: ACCESS_KEY,
      secretAccessKey: Redacted.make(setup.secret ?? SECRET_KEY),
    },
    fetch: setup.fetch ?? bucket.fetch,
  });
}

describeSecretFiles("an S3 bucket", async () => ({
  files: client(fakeBucket()),
}));

describeSecretFiles("an S3 bucket under a prefix", async () => ({
  files: client(fakeBucket(), { prefix: "/vaults/me/" }),
}));

describe("an S3 bucket", () => {
  it("keeps the vault under its prefix, and sees nothing beside it", async () => {
    const bucket = fakeBucket();
    const outside = client(bucket, { prefix: "other" });
    const inside = client(bucket, { prefix: "mine" });
    await Effect.runPromise(outside.write("a.json", bytes("theirs")));
    await Effect.runPromise(inside.write("a.json", bytes("mine")));
    expect([...bucket.objects.keys()].sort()).toEqual([
      "mine/a.json",
      "other/a.json",
    ]);
    expect(await Effect.runPromise(inside.list(""))).toEqual(["a.json"]);
  });

  it("pages a long listing to its end", async () => {
    const bucket = fakeBucket(2);
    const files = client(bucket);
    for (const name of ["a", "b", "c", "d", "e"]) {
      await Effect.runPromise(files.write(`t/${name}.json`, bytes(name)));
    }
    expect(await Effect.runPromise(files.list("t"))).toEqual([
      "t/a.json",
      "t/b.json",
      "t/c.json",
      "t/d.json",
      "t/e.json",
    ]);
  });

  it("stores the sealed bytes as written, with a bucket ETag that is not the revision", async () => {
    const bucket = fakeBucket();
    const revision = await Effect.runPromise(
      client(bucket).write("a.json", bytes("sealed")),
    );
    expect(new TextDecoder().decode(bucket.objects.get("a.json")?.bytes)).toBe(
      "sealed",
    );
    expect(bucket.objects.get("a.json")?.etag).not.toContain(revision);
  });

  it("lets the bucket decide a race: a put against a stale ETag is a conflict", async () => {
    const bucket = fakeBucket();
    const files = client(bucket);
    const first = await Effect.runPromise(files.write("a.json", bytes("one")));
    // Another writer lands between our read of the object and our put.
    const racing: typeof fetch = async (input, init) => {
      const request = new Request(input, init);
      if (request.method === "GET") {
        const answer = await bucket.fetch(request);
        bucket.objects.set("a.json", {
          bytes: bytes("rival"),
          etag: '"rival"',
        });
        return answer;
      }
      return bucket.fetch(request);
    };
    const error = await failureOf(
      client(bucket, { fetch: racing }).write("a.json", bytes("two"), {
        ifRevision: first,
      }),
    );
    expect(error._tag).toBe("SecretFsConflict");
  });

  it("is refused by a bucket that does not know the key, as a permission and not a retry", async () => {
    const error = await failureOf(
      client(fakeBucket(), {
        secret: "wrong-secret-key-0123456789abcdef", // gitleaks:allow -- deliberately invalid signature fixture
      }).read("a.json"),
    );
    expect(error).toMatchObject({
      _tag: "SecretFsRejected",
      kind: "permission",
    });
  });

  it("sends a credential over https, or over http only to this machine", () => {
    const base = {
      region: REGION,
      bucket: BUCKET_NAME,
      credentials: {
        accessKeyId: ACCESS_KEY,
        secretAccessKey: Redacted.make(SECRET_KEY),
      },
    };
    expect(() =>
      makeS3SecretFiles({ ...base, endpoint: "http://nas.local:9000" }),
    ).toThrow(/https/);
    expect(() =>
      makeS3SecretFiles({ ...base, endpoint: "http://localhost:9000" }),
    ).not.toThrow();
    expect(() =>
      makeS3SecretFiles({ ...base, endpoint: "https://nas.local" }),
    ).not.toThrow();
    expect(() =>
      makeS3SecretFiles({
        ...base,
        endpoint: "https://nas.local",
        bucket: "No_Good",
      }),
    ).toThrow(/bucket/);
  });

  it("addresses the bucket by host when asked", async () => {
    const urls: string[] = [];
    const spy: typeof fetch = async (input) => {
      urls.push(String(input instanceof Request ? input.url : input));
      return new Response(null, { status: 404 });
    };
    const files = makeS3SecretFiles({
      endpoint: "https://s3.eu-west-1.amazonaws.com",
      region: REGION,
      bucket: BUCKET_NAME,
      addressing: "virtual",
      credentials: {
        accessKeyId: ACCESS_KEY,
        secretAccessKey: Redacted.make(SECRET_KEY),
      },
      fetch: spy,
    });
    await failureOf(files.read("a.json"));
    expect(urls[0]).toBe(
      "https://vault-bucket.s3.eu-west-1.amazonaws.com/a.json",
    );
  });

  it("never puts the secret key in a failure or follows a redirect", async () => {
    const seen: RequestInit[] = [];
    const down: typeof fetch = (_input, init) => {
      seen.push(init ?? {});
      return Promise.reject(
        new TypeError(`connect ECONNREFUSED ${SECRET_KEY}`),
      );
    };
    const error = await failureOf(
      client(fakeBucket(), { fetch: down }).read("a.json"),
    );
    expect(JSON.stringify(error)).not.toContain(SECRET_KEY);
    expect(error._tag).toBe("SecretFsUnavailable");
    expect(seen[0]?.redirect).toBe("error");
  });

  it("is resilient end to end: a dropped connection mid-write is retried to done", async () => {
    const bucket = fakeBucket();
    let calls = 0;
    const lossy: typeof fetch = async (input, init) => {
      const answer = await bucket.fetch(input, init);
      calls += 1;
      if (calls === 1) throw new TypeError("socket hang up");
      return answer;
    };
    const files = await Effect.runPromise(
      resilient(client(bucket, { fetch: lossy }), {
        backoff: Duration.millis(1),
      }),
    );
    await Effect.runPromise(
      files.write("a.json", bytes("once"), { ifRevision: null }),
    );
    // The put that landed, the retry the bucket refused as already there,
    // and the read that confirms the file is the one we wrote.
    expect(calls).toBe(3);
    expect(bucket.objects.size).toBe(1);
  });
});
