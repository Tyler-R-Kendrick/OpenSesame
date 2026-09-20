/**
 * Step — ai. Same two slug selects as Settings › Connections › Models.
 */

import { useEffect, useState } from "react";
import { browserInference } from "../../../lib/browser-inference.js";
import { detectSpeechRecognition } from "../../../lib/command-bar/speech.js";
import {
  type ModelProviderRecord,
  loadModelProvider,
  saveModelProvider,
} from "../../../lib/model-provider.js";
import {
  type ModelSlugOption,
  connectedHarnessProviderIds,
  inferenceSlugOptions,
  voiceSlugOptions,
} from "../../../lib/model-slugs.js";
import { ModelRoleSelects } from "../../../sections/settings/AiModelRoles.js";

export function AiStep() {
  const [record, setRecord] = useState<ModelProviderRecord>(loadModelProvider);
  const [busy, setBusy] = useState(false);
  const [voiceOptions] = useState(() =>
    voiceSlugOptions(detectSpeechRecognition() !== null),
  );
  const [inferenceOptions, setInferenceOptions] = useState<ModelSlugOption[]>(
    () =>
      inferenceSlugOptions({
        browserReady: false,
        connectedProviderIds: [],
      }),
  );

  useEffect(() => {
    let live = true;
    void (async () => {
      const [browser, connected] = await Promise.all([
        browserInference(),
        connectedHarnessProviderIds(),
      ]);
      if (!live) return;
      setInferenceOptions(
        inferenceSlugOptions({
          browserReady: browser.plane === "builtin",
          connectedProviderIds: connected,
        }),
      );
    })();
    return () => {
      live = false;
    };
  }, []);

  const commit = (next: ModelProviderRecord) => {
    setBusy(true);
    void saveModelProvider(next)
      .then(() => setRecord(next))
      .finally(() => setBusy(false));
  };

  return (
    <ModelRoleSelects
      record={record}
      busy={busy}
      voiceOptions={voiceOptions}
      inferenceOptions={inferenceOptions}
      onCommit={commit}
    />
  );
}
