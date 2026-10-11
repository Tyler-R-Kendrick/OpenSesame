/**
 * The Environments sheet (ADR 0192): the vault's environments as tabs, the
 * keys in the one in view with their values and whether each is required
 * there, a way to add a key from the vault, and the `.env.schema` those
 * generate. Opened from the vault's own key strip, or by a notice.
 */

import { useRef } from "react";
import { FailureNotice } from "../../components/FailureNotice.js";
import { IconLayers, IconX } from "../../components/Icons.js";
import { useModalFocus } from "../../lib/modal-focus.js";
import { EnvironmentTabs } from "./EnvironmentTabs.js";
import { KeyPicker } from "./KeyPicker.js";
import { KeyRow } from "./KeyRow.js";
import { SchemaBlock } from "./SchemaBlock.js";
import { useEnvironments } from "./use-environments.js";
import "./environments.css";

export function EnvironmentsSheet({ onClose }: { onClose: () => void }) {
  const sheetRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  useModalFocus(true, sheetRef, closeRef, onClose);
  const env = useEnvironments();
  const { active } = env;

  return (
    <div className="sheet-layer env">
      <button
        type="button"
        className="scrim"
        aria-label="Close"
        onClick={onClose}
      />
      <div
        ref={sheetRef}
        className="sheet"
        // biome-ignore lint/a11y/useSemanticElements: native <dialog open> inerts the page and paints a blank top-layer surface
        role="dialog"
        aria-label="Environments"
        aria-modal="true"
      >
        <div className="sheet__head">
          <span className="sheet__mark" aria-hidden="true">
            <IconLayers size={20} />
          </span>
          <div className="sheet__grow">
            <h2>Environments</h2>
          </div>
          <button
            ref={closeRef}
            type="button"
            className="icon-btn"
            aria-label="Close"
            title="Close"
            onClick={onClose}
          >
            <IconX size={18} />
          </button>
        </div>
        <div className="sheet__body">
          <EnvironmentTabs
            names={env.names}
            active={active}
            invalid={env.nameRefused}
            onChoose={env.choose}
            onAdd={env.addEnvironment}
            onRemove={(name) => {
              void env.edit({ op: "remove-environment", name });
            }}
          />
          {active === null ? null : (
            <div
              id="env-panel"
              className="env__panel"
              role="tabpanel"
              aria-labelledby={`env-tab-${active}`}
            >
              {env.keys.length > 0 ? (
                <ul className="env__keys">
                  {env.keys.map((entry) => (
                    // One row per key *and* environment: a tab change unmounts
                    // it, so a value still being typed is committed to the
                    // environment it was typed in, never to the next one.
                    <KeyRow
                      key={`${entry.id}:${active}`}
                      entry={entry}
                      environment={active}
                      edit={env.edit}
                    />
                  ))}
                </ul>
              ) : null}
              <KeyPicker
                candidates={env.candidates}
                onPick={(itemId) => {
                  void env.edit({ op: "add-key", itemId });
                }}
              />
              {env.keys.length > 0 ? <SchemaBlock schema={env.schema} /> : null}
            </div>
          )}
          <FailureNotice
            id="vault.environments.edit"
            title="Environments"
            message={env.failure}
          />
        </div>
      </div>
    </div>
  );
}
