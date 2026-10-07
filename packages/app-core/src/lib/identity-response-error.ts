import { type JsonObject, isString, overlapCast } from "@opensesame/os-domain";

export async function readIdentityError(res: Response): Promise<string> {
  try {
    const body: JsonObject = overlapCast(await res.json());
    if (isString(body.message)) return body.message;
    if (isString(body.error)) return body.error;
    return `Request failed (${res.status}).`;
  } catch {
    return `Request failed (${res.status}).`;
  }
}
