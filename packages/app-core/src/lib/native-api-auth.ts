import type { NativeApiHttpRequest } from "./native-api-http.js";
/** Attach one provider credential according to its compiled injection rule. */
import {
  type NativeApiCredentials,
  type NativeApiTarget,
  providerTemplate,
  providerUrl,
} from "./native-api-target.js";

/** Reflected wire encodings are private just like the original credential bytes. */
export function nativeApiExposedCredentials(
  target: NativeApiTarget,
  credentials: Record<string, string>,
): NativeApiCredentials {
  const secrets = { ...credentials };
  for (const [name, value] of Object.entries(credentials)) {
    const encoded = encodeURIComponent(value);
    if (encoded !== value) secrets[`url_${name}`] = encoded;
  }
  if (target.profile.auth?.kind === "basic") {
    const authorization = nativeApiHeaders(target, credentials).get(
      "authorization",
    );
    if (authorization)
      secrets.basic_authorization = authorization.slice("Basic ".length);
  }
  return secrets;
}

export function nativeApiHeaders(
  target: NativeApiTarget,
  credentials: Record<string, string>,
): Headers {
  const headers = new Headers();
  for (const [name, template] of Object.entries(
    target.profile.verify?.headers ?? {},
  )) {
    const optionalEmpty = [...template.matchAll(/\{([a-z_]+)\}/g)].some(
      (match) => {
        const field = target.profile.templateParams.find(
          (entry) => entry.name === match[1],
        );
        return (
          field &&
          !field.required &&
          !target.parameters[field.name] &&
          !credentials[field.name]
        );
      },
    );
    if (!optionalEmpty)
      headers.set(
        name,
        providerTemplate(template, target.parameters, credentials),
      );
  }
  const auth = target.profile.auth;
  if (auth?.kind === "header") {
    const token = credentials.api_key ?? "";
    headers.set(
      auth.header,
      auth.valueTemplate
        ? providerTemplate(auth.valueTemplate, target.parameters, credentials)
        : `${auth.scheme ? `${auth.scheme} ` : ""}${token}`,
    );
  }
  if (auth?.kind === "basic") {
    const username = providerTemplate(
      auth.username,
      target.parameters,
      credentials,
    );
    const password = providerTemplate(
      auth.password,
      target.parameters,
      credentials,
    );
    if (username.includes(":"))
      throw new Error("Enter a valid provider Basic username");
    headers.set("Authorization", `Basic ${btoa(`${username}:${password}`)}`);
  }
  return headers;
}

export function nativeApiVerificationRequest(
  target: NativeApiTarget,
  credentials: Record<string, string>,
): NativeApiHttpRequest {
  const verify = target.profile.verify;
  if (!verify) throw new Error("Provider verification is unavailable");
  const url = providerUrl(verify.url, target, credentials);
  const headers = nativeApiHeaders(target, credentials);
  const auth = target.profile.auth;
  if (
    auth?.kind === "query" &&
    url.searchParams.get(auth.parameter) !== credentials.api_key
  )
    throw new Error(
      "Provider verification does not match its query credential contract",
    );
  if (auth?.kind === "path") {
    const prefix = providerTemplate(
      auth.template,
      target.parameters,
      credentials,
      true,
    );
    if (!url.pathname.startsWith(`${prefix}/`))
      throw new Error(
        "Provider verification does not match its path credential contract",
      );
  }
  const body =
    verify.body === null
      ? undefined
      : providerTemplate(verify.body, target.parameters, credentials);
  const request: NativeApiHttpRequest = { url, method: verify.method, headers };
  if (body !== undefined) request.body = body;
  return request;
}
