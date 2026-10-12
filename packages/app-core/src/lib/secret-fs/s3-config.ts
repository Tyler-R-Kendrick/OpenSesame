/**
 * The saved S3 connection as a store configuration (ADR 0182). The `s3`
 * catalog provider (spec/connectors/catalog.json) is a device-local
 * configuration connector like any other: its public fields and its secret
 * fields are saved apart by `device-connectors`, and this joins them back
 * into what `makeS3SecretFiles` takes. It reads nothing itself, so it is the
 * same for a test, the setup ceremony and boot.
 */
import { Redacted } from "effect";
import type { S3FilesConfig } from "./s3.js";

/** Field names as the catalog declares them. */
export const S3_PROVIDER_ID = "s3";

export type S3Saved = Readonly<{
  fields: Readonly<Record<string, string>>;
  secrets: Readonly<Record<string, string>>;
}>;

const REQUIRED_FIELDS = ["endpoint", "region", "bucket", "access_key_id"];

const text = (value: string | undefined): string | undefined => {
  const trimmed = value?.trim();
  return trimmed === undefined || trimmed === "" ? undefined : trimmed;
};

/** The names still missing, or an empty list when the connection is whole. */
export function s3Missing(saved: S3Saved): string[] {
  const missing = REQUIRED_FIELDS.filter(
    (name) => text(saved.fields[name]) === undefined,
  );
  if (text(saved.secrets.secret_access_key) === undefined) {
    missing.push("secret_access_key");
  }
  return missing;
}

/** The store configuration, or null while the connection is incomplete. */
export function s3ConfigFrom(
  saved: S3Saved,
): Omit<S3FilesConfig, "fetch" | "now"> | null {
  if (s3Missing(saved).length > 0) return null;
  const endpoint = text(saved.fields.endpoint);
  const region = text(saved.fields.region);
  const bucket = text(saved.fields.bucket);
  const accessKeyId = text(saved.fields.access_key_id);
  const secret = text(saved.secrets.secret_access_key);
  if (
    endpoint === undefined ||
    region === undefined ||
    bucket === undefined ||
    accessKeyId === undefined ||
    secret === undefined
  ) {
    return null;
  }
  const token = text(saved.secrets.session_token);
  return {
    endpoint,
    region,
    bucket,
    prefix: text(saved.fields.prefix),
    credentials: {
      accessKeyId,
      secretAccessKey: Redacted.make(secret),
      sessionToken: token === undefined ? undefined : Redacted.make(token),
    },
  };
}
