/**
 * Add a model provider (ADR 0189): a name, a key, a test that saves nothing,
 * and a save that proves the key first. It is the whole of connecting one — no
 * page, no method to choose, no scope to read — over the catalog the tile came
 * from. The key is sealed on this device and is sent only to the host the
 * catalog names for the provider.
 */
import {
  modelApiHost,
  modelProtocolLabel,
} from "@opensesame/app-core/lib/ai-model-provider.js";
import type { NativeConnectorView } from "@opensesame/app-core/lib/native-connector-view.js";
import type { Flash } from "@opensesame/app-core/sections/connections/shared.js";
import { useLayoutEffect, useRef } from "react";
import { CeremonySheet } from "../../../components/CeremonySheet.js";
import { CeremonyShell } from "../../../components/CeremonyShell.js";
import { FieldShell } from "../../../components/FieldShell.js";
import { IconKey } from "../../../components/IconKey.js";
import { IconConnection, IconPlay } from "../../../components/Icons.js";
import { StatusMark } from "../../../components/StatusMark.js";
import { NativeInputFields } from "../connect/NativeConnectorFields.js";
import type { AiSheetTarget } from "./ai-provider-sheet-target.js";
import { type KeyTest, useAiProviderForm } from "./use-ai-provider-form.js";

function testMark(test: KeyTest) {
  if (test.kind === "passed") return { tone: "ok" as const, label: test.label };
  if (test.kind === "failed") return { tone: "err" as const, label: test.text };
  return null;
}

function TestRow({
  test,
  disabled,
  onTest,
}: {
  test: KeyTest;
  disabled: boolean;
  onTest: () => void;
}) {
  const mark = testMark(test);
  return (
    <div className="ai-sheet__test">
      <IconKey label="Test connection" disabled={disabled} onClick={onTest}>
        <IconPlay size={16} />
      </IconKey>
      {mark ? <StatusMark tone={mark.tone} label={mark.label} /> : null}
    </div>
  );
}

export function AiProviderSheet({
  target,
  onClose,
  onConnected,
  onFlash,
}: {
  target: AiSheetTarget;
  onClose: () => void;
  onConnected: (view: NativeConnectorView) => void;
  onFlash: (flash: Flash) => void;
}) {
  const { provider, method } = target;
  const form = useAiProviderForm({ target, onConnected, onFlash });
  const fieldsRef = useRef<HTMLDivElement>(null);
  const keyRef = useRef<HTMLElement | null>(null);
  // The key is what the person came to paste, so it takes the focus — except
  // on a touch screen, where a keyboard that rises unasked covers the sheet.
  useLayoutEffect(() => {
    if (window.matchMedia?.("(pointer: coarse)").matches) return;
    keyRef.current =
      fieldsRef.current?.querySelector<HTMLElement>("input[type=password]") ??
      null;
  }, []);
  const host = modelApiHost(provider.id);
  const protocol = modelProtocolLabel(provider.id);
  const facts = [
    ...(host ? [{ key: "Sent to", value: host }] : []),
    ...(protocol ? [{ key: "Speaks", value: protocol }] : []),
    { key: "Kept", value: "sealed on this device" },
  ];
  return (
    <CeremonySheet
      title="Connect a model provider"
      mark={<IconConnection size={20} />}
      onClose={onClose}
      initialFocus={keyRef}
    >
      <form
        aria-label={`Connect ${provider.displayName}`}
        onSubmit={(event) => {
          event.preventDefault();
          void form.save();
        }}
      >
        <CeremonyShell
          ok={form.failure === ""}
          name={provider.displayName}
          facts={facts}
          primary={{
            label: "Save connection",
            submit: true,
            busy: form.busy,
            disabled: !form.ready,
            onClick: () => void form.save(),
          }}
        >
          <FieldShell
            id="ai-provider-name"
            label="Name"
            autoComplete="off"
            value={form.name}
            disabled={form.busy}
            onValueChange={form.setName}
          />
          <div ref={fieldsRef}>
            <NativeInputFields
              fields={method.fields}
              values={form.values}
              onChange={form.setValue}
            />
          </div>
          {form.canTest ? (
            <TestRow
              test={form.test}
              disabled={!form.ready}
              onTest={() => void form.runTest()}
            />
          ) : null}
        </CeremonyShell>
      </form>
    </CeremonySheet>
  );
}
