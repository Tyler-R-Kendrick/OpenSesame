import {
  type JsonObject,
  overlapCast,
  readString,
} from "@opensesame/os-domain";
export function readSecretToken(value: string): string {
  try {
    const secrets: JsonObject = overlapCast(JSON.parse(value));
    const token = readString(secrets.token)?.trim();
    if (token) return token;
    return readString(secrets.password)?.trim() || "";
  } catch {
    return "";
  }
}
