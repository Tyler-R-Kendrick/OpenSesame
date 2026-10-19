import { isString } from "@opensesame/os-domain";

export function nativeAuthFormFields(
  input: Readonly<Record<string, string>>,
  destination: string,
): [string, string][] {
  const fields = Object.entries(input);
  let bytes = 0;
  if (!fields.length || fields.length > 8)
    throw new Error("Invalid provider form fields");
  for (const [name, value] of fields) {
    if (
      !/^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(name) ||
      !isString(value) ||
      value.length > 393216
    )
      throw new Error("Invalid provider form field");
    bytes += new TextEncoder().encode(value).byteLength;
  }
  if (bytes > 524288 || new URL(destination).hash)
    throw new Error("Provider form request exceeds its bounds");
  return fields;
}
export function submitNativeAuthForm(
  popup: Window,
  destination: string,
  fields: [string, string][],
): void {
  if (popup.closed) throw new Error("Provider sign-in window was closed");
  const document = popup.document;
  const referrer = document.createElement("meta");
  referrer.name = "referrer";
  referrer.content = "no-referrer";
  document.head.append(referrer);
  const form = document.createElement("form");
  form.method = "POST";
  form.action = destination;
  form.target = "_self";
  for (const [name, value] of fields) {
    const input = document.createElement("input");
    input.type = "hidden";
    input.name = name;
    input.value = value;
    form.append(input);
  }
  document.body.replaceChildren(form);
  // A provider field named submit must not replace the native form method.
  HTMLFormElement.prototype.submit.call(form);
}
