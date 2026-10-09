/** Original Host transport capture. No credential classification or permit creation. */
import { host } from "../../host.js";

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
  if (!capture || format !== "node-projection-v1") unavailable();
  const reader = await capture(tomb, check);
  const read = reader.read;
  const validate = reader.revalidateRoot;
  const readerCheck = reader.check;
  const readerClose = reader.close;
  const close = async () => {
    if (closed) return;
    closed = true;
    await readerClose();
  };
  const completeCheck = () => {
    check();
    if (
      reader.read !== read ||
      reader.revalidateRoot !== validate ||
      reader.check !== readerCheck ||
      reader.close !== readerClose
    )
      unavailable();
    readerCheck();
    check();
  };
  try {
    completeCheck();
    await validate();
    completeCheck();
    return Object.freeze({
      bodyFormat: format,
      check: completeCheck,
      close,
      async revalidateRoot() {
        completeCheck();
        await validate();
        completeCheck();
      },
      async read() {
        completeCheck();
        const snapshot = await read();
        completeCheck();
        if (snapshot.tomb !== tomb) unavailable();
        return Object.freeze({
          tomb,
          header: snapshot.header,
          body: snapshot.body,
        });
      },
    });
  } catch (error) {
    await close();
    throw error;
  }
}
