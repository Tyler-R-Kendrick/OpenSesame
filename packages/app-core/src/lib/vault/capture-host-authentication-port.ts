import { isString } from "@opensesame/os-domain";
/** Original Host transport capture. No credential classification or permit creation. */
import { host } from "../../host.js";
import { disposeOriginalCommandData } from "./original-command-retirement-data.js";
import type {
  PhysicalAuthenticationPort,
  PhysicalAuthenticationReader,
} from "./physical-authentication-port.js";
const bindOriginal = Function.prototype.call.bind(Function.prototype.bind);

const DESCRIPTOR_KEYS: readonly (keyof PropertyDescriptor)[] = [
  "value",
  "get",
  "set",
  "writable",
  "configurable",
  "enumerable",
];
function sameDescriptor(
  a: PropertyDescriptor | undefined,
  b: PropertyDescriptor | undefined,
): boolean {
  if (!a || !b) return a === b;
  return DESCRIPTOR_KEYS.every((key) => a[key] === b[key]);
}
function unavailable(): never {
  throw new Error("Original physical vault authentication port changed.");
}

/** An eventual private issuer must independently verify the returned wrap/MAC/body/factors. */
export async function captureHostAuthenticationPort(
  tomb: string,
  original: () => void,
) {
  original();
  const installed = host();
  const port = installed.physicalVaultAuthentication;
  const descriptor = Object.getOwnPropertyDescriptor(
    installed,
    "physicalVaultAuthentication",
  );
  const capture = port?.capture;
  const format = port?.bodyFormat;
  let closed = false;
  const check = () => {
    original();
    if (
      closed ||
      !port ||
      host() !== installed ||
      installed.physicalVaultAuthentication !== port ||
      port.capture !== capture ||
      port.bodyFormat !== format ||
      !sameDescriptor(
        descriptor,
        Object.getOwnPropertyDescriptor(
          installed,
          "physicalVaultAuthentication",
        ),
      )
    )
      unavailable();
  };
  check();
  if (!capture || (format !== "node-projection-v1" && format !== "flat-v1"))
    unavailable();
  const reader = await capture(tomb, check);
  let readerClose: typeof reader.close | undefined;
  let closing: Promise<void> | undefined;
  const close = () => {
    if (closing) return closing;
    closed = true;
    closing = Promise.resolve().then(async () => {
      readerClose ??= reader.close;
      const fixedClose: typeof reader.close = bindOriginal(readerClose, reader);
      await fixedClose();
    });
    void closing.catch(() => {});
    return closing;
  };
  try {
    // Own delivered disposal before reading any later effectful port slot.
    readerClose = reader.close;
    return await captureReader(reader, tomb, format, check, close, readerClose);
  } catch (cause) {
    await disposeOriginalCommandData({ cause }, undefined, [close]);
    throw cause;
  }
}

async function captureReader(
  reader: PhysicalAuthenticationReader,
  tomb: string,
  format: PhysicalAuthenticationPort["bodyFormat"],
  check: () => void,
  close: () => Promise<void>,
  readerClose: PhysicalAuthenticationReader["close"],
) {
  const read = reader.read;
  const validate = reader.revalidateRoot;
  const readerCheck = reader.check;
  const readIdentity = reader.readOriginalStateIdentity;
  if (!readIdentity) unavailable();
  const fixedRead: typeof read = bindOriginal(read, reader);
  const fixedValidate: typeof validate = bindOriginal(validate, reader);
  const fixedCheck: typeof readerCheck = bindOriginal(readerCheck, reader);
  const fixedIdentity: typeof readIdentity = bindOriginal(readIdentity, reader);
  const completeCheck = () => {
    check();
    if (
      reader.read !== read ||
      reader.revalidateRoot !== validate ||
      reader.check !== readerCheck ||
      reader.close !== readerClose ||
      reader.readOriginalStateIdentity !== readIdentity
    )
      unavailable();
    fixedCheck();
    check();
  };
  completeCheck();
  await fixedValidate();
  completeCheck();
  return Object.freeze({
    bodyFormat: format,
    check: completeCheck,
    close,
    async readOriginalStateIdentity() {
      completeCheck();
      const identity = await fixedIdentity();
      completeCheck();
      if (!isString(identity) || !identity || identity.length > 128)
        unavailable();
      return identity;
    },
    async revalidateRoot() {
      completeCheck();
      await fixedValidate();
      completeCheck();
    },
    async read() {
      completeCheck();
      const snapshot = await fixedRead();
      completeCheck();
      if (snapshot.tomb !== tomb) unavailable();
      return Object.freeze({
        tomb,
        header: snapshot.header,
        body: snapshot.body,
      });
    },
  });
}
