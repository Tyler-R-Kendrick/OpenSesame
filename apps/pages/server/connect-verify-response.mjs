import { isJsonObject } from "./json-boundary.mjs";

function field(body, path) {
  let value = body;
  for (const key of path.split(".")) {
    if (["__proto__", "prototype", "constructor"].includes(key))
      return undefined;
    if (Array.isArray(value) && /^\d+$/.test(key)) value = value[Number(key)];
    else if (isJsonObject(value) && Object.hasOwn(value, key))
      value = value[key];
    else return undefined;
  }
  return value;
}

function present(value) {
  return (
    value !== undefined &&
    value !== null &&
    value !== false &&
    value !== "" &&
    (!Array.isArray(value) || value.length > 0)
  );
}

/** Read only compiled paths; HTTP success alone cannot prove credentials. */
export function providerAnswered(body, target) {
  if (target.kind === "mcp") return true;
  if (!isJsonObject(body) && !Array.isArray(body)) return false;
  if (
    isJsonObject(body) &&
    (body.ok === false || Object.keys(body).length === 0)
  )
    return false;
  for (const path of new Set([
    "error",
    "errors",
    ...(target.errorFields ?? []),
  ]))
    if (present(field(body, path))) return false;
  return declaredFieldsMatch(body, target);
}

function declaredFieldsMatch(body, target) {
  for (const condition of target.success ?? [])
    if (field(body, condition.field) !== condition.equals) return false;
  for (const path of target.requiredFields ?? []) {
    const value = field(body, path);
    if (value === undefined || value === null || value === "") return false;
  }
  return true;
}

/** Existing size-only proofs stay supported; semantic proofs need their actual fields. */
export function truncatedProofAllowed(target) {
  return (
    !target.success?.length &&
    !target.requiredFields?.length &&
    !target.errorFields?.length
  );
}
