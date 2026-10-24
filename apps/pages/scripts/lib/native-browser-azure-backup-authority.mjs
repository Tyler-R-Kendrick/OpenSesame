/** Synthetic official Set/Get Secret wire contract; preserves supplied value bytes. */
// https://learn.microsoft.com/en-us/rest/api/keyvault/secrets/set-secret/set-secret
// https://learn.microsoft.com/en-us/rest/api/keyvault/secrets/get-secret/get-secret
import { z } from "zod";

const MAX_SECRET_BYTES = 25 * 1024;
const rawWrite = z.string().max(MAX_SECRET_BYTES + 512);
const writeBody = z
  .object({
    value: z
      .string()
      .refine((value) => Buffer.byteLength(value) <= MAX_SECRET_BYTES),
  })
  .strict();
const BACKUP_PATH =
  /^\/secrets\/(opensesame-browser-backup-(?:desktop|phone))(?:\/([a-f0-9]{32}))?$/;

function backupReference(fixture, request) {
  const url = new URL(request.url());
  const match = BACKUP_PATH.exec(url.pathname);
  if (
    url.origin !== fixture.vaultURL ||
    !match ||
    url.username ||
    url.password ||
    url.hash ||
    url.search !== `?api-version=${fixture.apiVersion}`
  )
    return null;
  return {
    name: match[1],
    version: match[2],
    id: `${url.origin}${url.pathname}`,
    url: url.href,
  };
}
function supportedBackupWire(request, headers, reference) {
  const method = request.method();
  if (headers.cookie || headers.accept !== "application/json") return false;
  if (method === "GET") return request.postData() === null;
  return (
    method === "PUT" &&
    !reference.version &&
    headers["content-type"] === "application/json"
  );
}

export function createAzureBackupAuthority(fixture, authority, harness) {
  const saved = new Map();
  const versions = new Map();
  let serial = 0;
  const observation = { saved, calls: [] };
  authority.azureBackup = observation;
  function response(request, status, body) {
    if (status !== 200) authority.state.expectedResponses.set(request, status);
    return {
      status,
      contentType: "application/json",
      body: JSON.stringify(body),
    };
  }
  function write(request, name) {
    const raw = rawWrite.safeParse(request.postData());
    if (!raw.success || Buffer.byteLength(raw.data) > MAX_SECRET_BYTES + 512)
      return response(request, 400, { error: { code: "BadParameter" } });
    let parsed;
    try {
      parsed = JSON.parse(raw.data);
    } catch {
      return response(request, 400, { error: { code: "BadParameter" } });
    }
    const body = writeBody.safeParse(parsed);
    if (!body.success)
      return response(request, 400, { error: { code: "BadParameter" } });
    serial++;
    const bundle = {
      id: `${fixture.vaultURL}/secrets/${name}/${serial.toString(16).padStart(32, "0")}`,
      value: body.data.value,
    };
    saved.set(name, bundle);
    versions.set(bundle.id, bundle);
    return response(request, 200, bundle);
  }
  return {
    appendMetadata(page) {
      for (const name of saved.keys())
        page.value.push({ id: `${fixture.vaultURL}/secrets/${name}` });
    },
    dispatch(request, headers) {
      const reference = backupReference(fixture, request);
      if (!reference || !supportedBackupWire(request, headers, reference))
        return null;
      const method = request.method();
      authority.state.calls.push({
        providerId: fixture.providerId,
        method,
        purpose: "backup",
        operation: method === "PUT" ? "backup.write" : "backup.read",
      });
      observation.calls.push({ method, url: reference.url });
      harness.check(
        !headers.cookie,
        "azure-sm: encrypted backup requests omit cookies",
      );
      if (
        headers.authorization !== `Bearer ${fixture.token}` ||
        authority.state.reject.has(fixture.providerId)
      )
        return response(request, 401, { error: { code: "Unauthorized" } });
      if (method === "PUT") return write(request, reference.name);
      const bundle = reference.version
        ? versions.get(reference.id)
        : saved.get(reference.name);
      return bundle
        ? response(request, 200, bundle)
        : response(request, 404, { error: { code: "SecretNotFound" } });
    },
  };
}
