/**
 * State and actions for the Add-a-model-provider sheet (ADR 0192): a name, the
 * key, a test that saves nothing, and a save that proves the key first. The
 * same controller the provider's page uses does both, so the sheet is only a
 * smaller front to one road, never a second one.
 */
import { connectPlan } from "@opensesame/app-core/lib/connect-plan.js";
import type { NativeConnectorView } from "@opensesame/app-core/lib/native-connector-view.js";
import {
  type Flash,
  errorText,
} from "@opensesame/app-core/sections/connections/shared.js";
import { useMemo, useState } from "react";
import { nativeConnectorController } from "../connect/native-connector-controller.js";
import { nativeInitialValues } from "../connect/native-connector-edit-values.js";
import {
  nativeError,
  nativeFieldValues,
  nativeMissingField,
  nativeNextValues,
  nativeVerified,
} from "../connect/native-connector-ui-values.js";
import type {
  NativeConfigureInput,
  NativeFieldValues,
  NativeMethodDescriptor,
} from "../connect/native-connector-ui.js";
import type { AiSheetTarget } from "./ai-provider-sheet-target.js";

export type KeyTest =
  | { kind: "idle" }
  | { kind: "testing" }
  | { kind: "passed"; label: string }
  | { kind: "failed"; text: string };

type Options = {
  target: AiSheetTarget;
  /** A verified save leaves the sheet; what it says is the page it lands on's to show. */
  onConnected: (flash: Flash) => void;
  onFlash: (flash: Flash) => void;
};

/** What the sheet submits: the name, and each field on the side its kind says. */
function configureInput(
  name: string,
  method: NativeMethodDescriptor,
  values: NativeFieldValues,
): NativeConfigureInput {
  return {
    method: "api-key",
    displayName: name.trim(),
    parameters: nativeFieldValues(method.fields, values, false),
    credentials: nativeFieldValues(method.fields, values, true),
    requestedScopes: {},
    targetIds: {},
  };
}

/** A failure as the person reads it: no credential they typed survives in it. */
function failureText<Thrown>(error: Thrown, request: NativeConfigureInput) {
  return nativeError(errorText(error), request.credentials);
}

/** What saving told the person: verified and kept, or saved and still to verify. */
function savedFlash(view: NativeConnectorView, providerName: string): Flash {
  return nativeVerified(view)
    ? {
        tone: "ok",
        text: `${providerName} access verified and saved on this device.`,
      }
    : { tone: "warn", text: `Verify ${providerName} to connect.` };
}

export function useAiProviderForm({ target, onConnected, onFlash }: Options) {
  const { provider, descriptor, method } = target;
  const controller = useMemo(
    () =>
      nativeConnectorController({
        id: provider.id,
        refused: connectPlan(provider.id)?.refused ?? false,
      }),
    [provider.id],
  );
  const [name, setName] = useState(descriptor.name);
  const [values, setValues] = useState(() => nativeInitialValues(method));
  const [busy, setBusy] = useState(false);
  const [test, setTest] = useState<KeyTest>({ kind: "idle" });
  const [failure, setFailure] = useState("");

  const ready =
    !busy && name.trim() !== "" && !nativeMissingField(method.fields, values);
  const input = () => configureInput(name, method, values);
  const clearOutcome = () => {
    setTest({ kind: "idle" });
    setFailure("");
  };

  async function runTest() {
    if (!controller.test || !ready) return;
    const request = input();
    setBusy(true);
    setFailure("");
    setTest({ kind: "testing" });
    try {
      const result = await controller.test(request);
      setTest({ kind: "passed", label: result.label });
    } catch (error) {
      const text = failureText(error, request);
      setTest({ kind: "failed", text });
      onFlash({ tone: "err", text });
    } finally {
      setBusy(false);
    }
  }

  async function save() {
    if (!ready) return;
    const request = input();
    setBusy(true);
    setFailure("");
    try {
      const view = await controller.configure(request);
      if (view.providerId !== provider.id)
        throw new Error("Provider returned a different connection.");
      const saved = savedFlash(view, descriptor.name);
      if (nativeVerified(view)) onConnected(saved);
      else onFlash(saved);
    } catch (error) {
      const text = failureText(error, request);
      setFailure(text);
      setTest({ kind: "failed", text });
      onFlash({ tone: "err", text });
    } finally {
      setBusy(false);
    }
  }

  return {
    name,
    values,
    busy,
    ready,
    test,
    failure,
    canTest: controller.test !== undefined,
    setName: (next: string) => {
      setName(next);
      setFailure("");
    },
    setValue: (id: string, value: string) => {
      setValues((current) =>
        nativeNextValues(method.fields, current, id, value),
      );
      clearOutcome();
    },
    runTest,
    save,
  };
}
