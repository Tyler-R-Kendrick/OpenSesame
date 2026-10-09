import { Duration, Effect, Redacted } from "effect";
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
import { describeVaultOnFiles } from "./vault-on-files.conformance.js";

// The shape a PWA runs in when its vault lives in a bucket: the whole vault
// conformance suite on an S3-compatible store, with the retry and breaker
// policy on, as setup wires it.
describeVaultOnFiles("an S3 bucket", async () => {
  const bucket = fakeBucket(50);
  const client = makeS3SecretFiles({
    endpoint: ENDPOINT,
    region: REGION,
    bucket: BUCKET_NAME,
    prefix: "vaults/me",
    credentials: {
      accessKeyId: ACCESS_KEY,
      secretAccessKey: Redacted.make(SECRET_KEY),
    },
    fetch: bucket.fetch,
  });
  return {
    files: await Effect.runPromise(
      resilient(client, { backoff: Duration.millis(1) }),
    ),
  };
});
