import {
  type BoundaryValue,
  isJsonObject,
  isNumber,
  isString,
} from "@opensesame/os-domain";
import {
  SecretBackendError,
  type SecretBackendItem,
  type SecretBackendItemInput,
  type SecretBackendItemSummary,
} from "./types.js";

export function passwordstateId(value: BoundaryValue): string {
  const id =
    isNumber(value) && Number.isSafeInteger(value) ? String(value) : value;
  if (!isString(id) || !/^[1-9][0-9]{0,14}$/.test(id))
    throw new SecretBackendError(
      "response",
      "Passwordstate returned an invalid record ID.",
    );
  return id;
}

export function passwordstateSummary(
  value: BoundaryValue,
): SecretBackendItemSummary {
  if (!isJsonObject(value) || !isString(value.Title))
    throw new SecretBackendError(
      "response",
      "Passwordstate returned an unreadable password record.",
    );
  return {
    id: passwordstateId(value.PasswordID),
    name: value.Title,
    kind: "login",
  };
}

export function passwordstateRows(value: BoundaryValue): BoundaryValue[] {
  if (!Array.isArray(value))
    throw new SecretBackendError(
      "response",
      "Passwordstate returned an unreadable password list.",
    );
  return value;
}

export function passwordstateItem(value: BoundaryValue): SecretBackendItem {
  const rows = passwordstateRows(value);
  if (rows.length !== 1)
    throw new SecretBackendError(
      "response",
      "Passwordstate did not return exactly one password record.",
    );
  const row = rows[0];
  if (!isJsonObject(row) || !isString(row.Password) || isString(row.Status))
    throw new SecretBackendError(
      "response",
      "Passwordstate did not confirm a stored password value. Managed password resets may still be queued.",
    );
  const item: SecretBackendItem = {
    ...passwordstateSummary(row),
    secret: row.Password,
    notes: isString(row.Notes) ? row.Notes : "",
  };
  if (isString(row.UserName)) item.username = row.UserName;
  if (isString(row.URL)) item.url = row.URL;
  return item;
}

export function passwordstateWrite(input: SecretBackendItemInput) {
  if (!input.name.trim() || input.name.length > 255)
    throw new SecretBackendError(
      "configuration",
      "Enter a password title of up to 255 characters.",
    );
  if (Object.keys(input.fields ?? {}).length)
    throw new SecretBackendError(
      "unsupported",
      "Configure Passwordstate generic fields in Passwordstate before editing them through this connection.",
    );
  const body = {
    Title: input.name,
    Notes: input.notes,
    Password: input.secret,
    UserName: input.username ?? "",
    URL: input.url ?? "",
  };
  if (body.UserName.length > 255 || body.URL.length > 255)
    throw new SecretBackendError(
      "configuration",
      "Passwordstate usernames and URLs must be at most 255 characters.",
    );
  return body;
}
