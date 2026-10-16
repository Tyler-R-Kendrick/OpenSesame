import type {
  SecretBackendCapabilities,
  SecretBackendItem,
  SecretBackendItemInput,
  SecretBackendItemSummary,
} from "@opensesame/app-core/lib/secret-backends/types.js";
import { type FormEvent, useLayoutEffect, useRef, useState } from "react";
import { FormCommit } from "../../../components/FormCommit.js";
import { IconKey } from "../../../components/IconKey.js";
import { IconX } from "../../../components/Icons.js";
import { firstControl, keyboardIsIdle, landFocus } from "../../../lib/focus.js";
import { SecretBackendItemFields } from "./SecretBackendItemFields.js";

type Props = {
  item: SecretBackendItem | null;
  editing: boolean;
  busy: boolean;
  onSave: (input: SecretBackendItemInput) => void;
  onClose: () => void;
  itemKinds?: readonly SecretBackendItemSummary["kind"][];
  itemFields?: SecretBackendCapabilities["itemFields"];
};
function emptyItem(kinds: Props["itemKinds"]): SecretBackendItemInput {
  return {
    name: "",
    notes: "",
    secret: "",
    kind: kinds?.[0] ?? "note",
    username: "",
    url: "",
  };
}

/** Retrieved values stay in this session's editor and clear when it is closed. */
export function SecretBackendItemForm(props: Props) {
  const { item, editing, busy, onSave, onClose } = props;
  const root = useRef<HTMLFormElement>(null);
  useLayoutEffect(() => {
    if (editing || keyboardIsIdle()) landFocus(firstControl(root.current));
  }, [editing]);
  const [draft, setDraft] = useState<SecretBackendItemInput>(
    () => item ?? emptyItem(props.itemKinds),
  );
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    onSave(draft);
  }
  return (
    <form
      className="cx-form panel__body"
      aria-label="Backend item"
      onSubmit={submit}
      ref={root}
    >
      <SecretBackendItemFields
        draft={draft}
        existing={!!item}
        editing={editing}
        busy={busy}
        onChange={setDraft}
        kinds={props.itemKinds}
        fields={props.itemFields}
      />
      {editing ? (
        <FormCommit
          label={item ? "Update backend item" : "Create backend item"}
          disabled={busy}
          busy={busy}
        >
          <IconKey
            label="Cancel backend item edit"
            disabled={busy}
            onClick={onClose}
          >
            <IconX size={17} />
          </IconKey>
        </FormCommit>
      ) : null}
    </form>
  );
}
