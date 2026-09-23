/**
 * The document sheet's actions, kept out of the component so the sheet is
 * markup and wiring only. Each action is one intention (B12): open, save
 * under the existing policy, encrypt new content, rotate onto a new key.
 */

import { setStatusNotice } from "@opensesame/app-core/lib/notices.js";
import {
  downloadText,
  encryptedName,
} from "@opensesame/app-core/lib/sops/download.js";
import { parseAgeRecipient } from "@opensesame/app-core/lib/sops/keys/age.js";
import {
  type EncryptionPlan,
  planFromRecipients,
} from "@opensesame/app-core/lib/sops/plan.js";
import type {
  SopsWorkflow,
  WorkflowState,
} from "@opensesame/app-core/lib/sops/workflow.js";
import { identityList } from "@opensesame/app-core/sections/settings/sops/identities.js";
import { useCallback } from "react";

export function notice(tone: "info" | "err", body: string): void {
  setStatusNotice({
    id: "formats-interoperability",
    tone,
    title: "SOPS",
    body,
  });
}

/** Recipients as typed: one group per line, spaces or commas within a line. */
export function parseGroups(text: string): string[][] {
  return text
    .split("\n")
    .map((line) => line.split(/[\s,]+/u).filter((entry) => entry !== ""))
    .filter((group) => group.length > 0);
}

export type DocumentActionsInput = {
  workflow: SopsWorkflow;
  state: WorkflowState;
  identity: string;
  recipients: string;
  threshold: string;
  vaultIdentities: readonly string[];
  scope: string | null;
};

export type DocumentActions = {
  onOpen: () => void;
  onSave: () => void;
  onEncryptNew: () => void;
  onRotate: () => void;
};

function message(caught: unknown, fallback: string): string {
  return caught instanceof Error ? caught.message : fallback;
}

export function useSopsDocumentActions(
  input: DocumentActionsInput,
): DocumentActions {
  const {
    workflow,
    state,
    identity,
    recipients,
    threshold,
    vaultIdentities,
    scope,
  } = input;

  const buildPlan = useCallback(
    (format: "yaml" | "json"): EncryptionPlan => {
      const groups = parseGroups(recipients);
      for (const group of groups)
        for (const entry of group) parseAgeRecipient(entry);
      const count = threshold.trim() === "" ? 0 : Number(threshold.trim());
      return planFromRecipients({
        format,
        groups,
        shamirThreshold: Number.isFinite(count) ? count : 0,
      });
    },
    [recipients, threshold],
  );

  const onOpen = useCallback(() => {
    let list: string[];
    try {
      list = identityList({ ephemeral: identity, vault: vaultIdentities });
    } catch (caught) {
      notice("err", message(caught, "That identity is not supported."));
      return;
    }
    if (list.length === 0) {
      notice(
        "err",
        "Supply an age identity, or unlock a vault that holds one.",
      );
      return;
    }
    void workflow.open(list, scope).then(() => {
      if (workflow.getSnapshot().phase === "open")
        notice("info", "Document verified and open.");
    });
  }, [identity, scope, vaultIdentities, workflow]);

  const onSave = useCallback(() => {
    void workflow.saveEncrypted(scope).then((output) => {
      if (!output) return;
      downloadText(
        encryptedName(state.fileName, state.format),
        output,
        "encrypted",
      );
      notice("info", "Encrypted copy saved.");
    });
  }, [scope, state.fileName, state.format, workflow]);

  const onEncryptNew = useCallback(() => {
    try {
      const plan = buildPlan(state.format);
      void workflow
        .encryptNew(workflow.contentForEncryption(), plan, scope)
        .then((output) => {
          if (!output) return;
          downloadText(
            encryptedName(state.fileName || "document", state.format),
            output,
            "encrypted",
          );
          notice("info", "Document encrypted.");
        });
    } catch (caught) {
      notice("err", message(caught, "Those recipients are not usable."));
    }
  }, [buildPlan, scope, state.fileName, state.format, workflow]);

  const onRotate = useCallback(() => {
    try {
      const plan = buildPlan(state.format);
      void workflow.rotate(plan, scope).then((output) => {
        if (!output) return;
        downloadText(
          encryptedName(state.fileName, state.format),
          output,
          "encrypted",
        );
        notice("info", "New data key, every selected recipient re-wrapped.");
      });
    } catch (caught) {
      notice("err", message(caught, "Those recipients are not usable."));
    }
  }, [buildPlan, scope, state.fileName, state.format, workflow]);

  return { onOpen, onSave, onEncryptNew, onRotate };
}
