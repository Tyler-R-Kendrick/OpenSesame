import { CONTEXT_LABEL } from "@opensesame/app-core/lib/keymap/context.js";
import { restoreKey } from "@opensesame/app-core/lib/keymap/effective.js";
import type { UnavailableBinding } from "@opensesame/app-core/sections/settings/keymap-panel-model.js";
import { useEffect, useRef, useState } from "react";
import { IconTrash } from "../../../components/Icons.js";
import { StatusMark } from "../../../components/StatusMark.js";
import { spoken } from "./KeyButton.js";
import { Keycaps } from "./Keycaps.js";
import type { KeymapState } from "./useKeymap.js";

function Row({
  binding,
  state,
  onRemoved,
}: {
  binding: UnavailableBinding;
  state: KeymapState;
  onRemoved: () => void;
}) {
  const where = binding.scope ? ` ${CONTEXT_LABEL[binding.scope]}` : "";
  const said = `${spoken(binding.sequence)}${where}`;
  return (
    <li className="kb-row kb-row--unavailable">
      <span className="kb-row__name">
        <code className="kb-row__id">{binding.target}</code>
      </span>
      <span className="kb-keys">
        <span
          className={`keycap-btn keycap-btn--fixed${binding.scope ? " keycap-btn--scoped" : ""}`}
          role="img"
          aria-label={said}
          title={said}
        >
          <Keycaps sequence={binding.sequence} />
        </span>
      </span>
      <span className="kb-row__end">
        <StatusMark
          tone="idle"
          label={`${binding.target} is not available on this plan`}
        />
        <button
          type="button"
          className="icon-btn icon-btn--sm"
          aria-label={`Remove ${said} from ${binding.target}`}
          title={`Remove ${said} from ${binding.target}`}
          onClick={() => {
            const refused = state.save(
              restoreKey(state.config, binding.sequence, binding.scope),
            );
            if (refused === null) onRemoved();
          }}
        >
          <IconTrash size={14} />
        </button>
      </span>
    </li>
  );
}

/**
 * A person's keys for commands this plan does not have — a jump whose
 * capability left. They are kept, so they come back with it, and listed so
 * they are never invisible.
 */
export function UnavailableKeys({
  bindings,
  state,
}: {
  bindings: readonly UnavailableBinding[];
  state: KeymapState;
}) {
  const list = useRef<HTMLUListElement>(null);
  const [land, setLand] = useState<number | null>(null);
  // The removed row is gone: the keyboard moves to the one that took its
  // place, or — the group gone too — to the panel's own head.
  useEffect(() => {
    if (land === null) return;
    const keys = list.current?.querySelectorAll<HTMLElement>("button");
    const next =
      keys?.[Math.min(land, keys.length - 1)] ??
      document.querySelector<HTMLElement>("#settings-keymap .head-filter");
    next?.focus();
    setLand(null);
  }, [land]);
  if (bindings.length === 0) return null;
  return (
    <section className="kb-group" aria-labelledby="kb-group-unavailable">
      <h3 className="kb-group__label" id="kb-group-unavailable">
        Unavailable
      </h3>
      <ul className="kb-rows" ref={list}>
        {bindings.map((binding, index) => (
          <Row
            key={`${binding.scope ?? ""}:${binding.sequence}`}
            binding={binding}
            state={state}
            onRemoved={() => setLand(index)}
          />
        ))}
      </ul>
    </section>
  );
}
