/** Fixed original header-transition producer capture; no authentication verdict is accepted. */
import { host } from "../../host.js";
import type { AuthenticationProjectionPlan } from "../secret-fs/authentication-projection-plan.js";
import { readAuthenticationProjectionTransition } from "../secret-fs/authentication-projection-transition.js";
import type { PhysicalAuthenticationSnapshot } from "./physical-authentication-port.js";
import type { PhysicalVaultPublicationReader } from "./physical-vault-publication-port.js";
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
  throw new Error("Original physical vault publication port changed.");
}
export async function captureHostVaultPublicationPort(
  tomb: string,
  original: () => void,
) {
  original();
  const installed = host();
  const port = installed.physicalVaultPublication;
  const capture = port?.capture;
  const descriptor = Object.getOwnPropertyDescriptor(
    installed,
    "physicalVaultPublication",
  );
  let closed = false;
  const check = () => {
    original();
    if (
      closed ||
      !port ||
      host() !== installed ||
      installed.physicalVaultPublication !== port ||
      port.capture !== capture ||
      !sameDescriptor(
        descriptor,
        Object.getOwnPropertyDescriptor(installed, "physicalVaultPublication"),
      )
    )
      unavailable();
  };
  check();
  if (!capture) unavailable();
  const reader = await capture(tomb, check);
  const {
    check: readerCheck,
    close,
    publishHeader,
    publishProjection,
  } = reader;
  const completeCheck = () => {
    check();
    if (
      reader.check !== readerCheck ||
      reader.close !== close ||
      reader.publishHeader !== publishHeader ||
      reader.publishProjection !== publishProjection
    )
      unavailable();
    readerCheck();
    check();
  };
  let draining: Promise<void> | undefined;
  const retire = () => {
    closed = true;
    draining ??= close();
    return draining;
  };
  try {
    completeCheck();
    return Object.freeze({
      check: completeCheck,
      close: retire,
      ...publicationMethods(
        tomb,
        { publishHeader, publishProjection },
        completeCheck,
      ),
    });
  } catch (error) {
    await retire();
    throw error;
  }
}

function publicationMethods(
  tomb: string,
  methods: Pick<
    PhysicalVaultPublicationReader,
    "publishHeader" | "publishProjection"
  >,
  completeCheck: () => void,
) {
  const { publishHeader, publishProjection } = methods;
  return {
    async publishProjection(
      expected: PhysicalAuthenticationSnapshot,
      plan: AuthenticationProjectionPlan,
      cancellation: () => void = () => {},
    ) {
      const held = Object.freeze({
        tomb: expected.tomb,
        header: expected.header,
        body: expected.body,
      });
      const originalPublication = () => {
        completeCheck();
        cancellation();
      };
      originalPublication();
      const transition = readAuthenticationProjectionTransition(plan);
      const result = await publishProjection(
        held,
        transition,
        originalPublication,
      );
      originalPublication();
      if (
        result.tomb !== tomb ||
        result.header !== held.header ||
        result.body !== transition.nextBody
      )
        unavailable();
      return result;
    },
    async publishHeader(
      expected: PhysicalAuthenticationSnapshot,
      next: string,
      cancellation: () => void = () => {},
    ) {
      const held = Object.freeze({
        tomb: expected.tomb,
        header: expected.header,
        body: expected.body,
      });
      const originalPublication = () => {
        completeCheck();
        cancellation();
      };
      originalPublication();
      const result = await publishHeader(held, next, originalPublication);
      originalPublication();
      if (
        result.tomb !== tomb ||
        result.header !== next ||
        result.body !== held.body
      )
        unavailable();
      return result;
    },
  };
}
