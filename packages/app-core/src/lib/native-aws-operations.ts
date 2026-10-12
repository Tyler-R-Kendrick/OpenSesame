import {
  type BoundaryValue,
  isJsonObject,
  isString,
} from "@opensesame/os-domain";
import { NativeApiError } from "./native-api-http.js";
import { safeProviderText } from "./native-api-verify.js";
import { nativeAwsCall } from "./native-aws-http.js";
import {
  NATIVE_AWS_SERVICES,
  type NativeAwsTarget,
} from "./native-aws-input.js";
import type { NativeProviderTransport } from "./native-connector-transport.js";

/** A value this large is not a credential someone reads on a page. */
const MAX_VALUE = 32 * 1024;

function entries(body: BoundaryValue, key: string): readonly BoundaryValue[] {
  const list = isJsonObject(body) ? body[key] : undefined;
  if (!Array.isArray(list)) throw new NativeApiError("response");
  return list;
}

/**
 * The first page of names, which proves the key may list them and says nothing
 * about their values. Bounded, and every name must have the shape AWS allows.
 */
export async function readNativeAwsNames(
  target: NativeAwsTarget,
  transport: NativeProviderTransport,
): Promise<{ id: string; label: string }[]> {
  const secrets = target.service === "aws";
  const body = await nativeAwsCall(
    target,
    transport,
    secrets ? "ListSecrets" : "DescribeParameters",
    { MaxResults: secrets ? 20 : 10 },
  );
  const allowed = NATIVE_AWS_SERVICES[target.service].allowedName;
  const rows = entries(body, secrets ? "SecretList" : "Parameters");
  if (rows.length > 100) throw new NativeApiError("response");
  return rows.map((row) => {
    const name = isJsonObject(row) ? row.Name : undefined;
    if (!isString(name) || !allowed.test(name))
      throw new NativeApiError("response");
    return { id: name, label: safeProviderText(name, target.credentials) };
  });
}

/** One value, read on a person's request and shown once, never kept. */
export async function readNativeAwsValue(
  target: NativeAwsTarget,
  transport: NativeProviderTransport,
  name: string,
): Promise<string> {
  if (!NATIVE_AWS_SERVICES[target.service].allowedName.test(name))
    throw new Error("Enter a valid name");
  const secrets = target.service === "aws";
  const body = await nativeAwsCall(
    target,
    transport,
    secrets ? "GetSecretValue" : "GetParameter",
    secrets ? { SecretId: name } : { Name: name, WithDecryption: true },
  );
  const holder = secrets
    ? body
    : isJsonObject(body)
      ? body.Parameter
      : undefined;
  const value = isJsonObject(holder)
    ? holder[secrets ? "SecretString" : "Value"]
    : undefined;
  // A binary secret has no honest text to show.
  if (!isString(value) || value.length > MAX_VALUE)
    throw new NativeApiError("response");
  return value;
}
