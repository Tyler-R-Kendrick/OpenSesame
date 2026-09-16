/**
 * Step — ai. Voice + inference catalog picks; same record as Settings › AI models.
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
  InferenceRefineFields,
  InferenceRolePicker,
  VoiceRolePicker,
} from "../../../sections/settings/AiModelRoles.js";

export function AiStep() {
  const [record, setRecord] = useState<ModelProviderRecord>(loadModelProvider);
  const [endpoint, setEndpoint] = useState(record.inference.endpoint);
  const [model, setModel] = useState(record.inference.model);
  const [busy, setBusy] = useState(false);
  const [browserReady, setBrowserReady] = useState(false);
  const [speechReady] = useState(() => detectSpeechRecognition() !== null);

  useEffect(() => {
    let live = true;
    void browserInference().then((verdict) => {
      if (live) setBrowserReady(verdict.plane === "builtin");
    });
    return () => {
      live = false;
    };
  }, []);

  const commit = (next: ModelProviderRecord) => {
    setBusy(true);
    void saveModelProvider(next)
      .then(() => {
        setRecord(next);
        setEndpoint(next.inference.endpoint);
        setModel(next.inference.model);
      })
      .finally(() => setBusy(false));
  };
  return (
    <>
      <VoiceRolePicker
        record={record}
        busy={busy}
        chrome="cards"
        speechReady={speechReady}
        onCommit={commit}
      />
      <InferenceRolePicker
        record={record}
        busy={busy}
        chrome="cards"
        browserReady={browserReady}
        onCommit={commit}
      />
      <InferenceRefineFields
        record={record}
        busy={busy}
        endpoint={endpoint}
        model={model}
        setEndpoint={setEndpoint}
        setModel={setModel}
        mode="blur"
        onCommit={commit}
      />
    </>
  );
}
