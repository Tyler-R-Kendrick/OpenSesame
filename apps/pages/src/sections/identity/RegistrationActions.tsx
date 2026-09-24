import type { RefObject } from "react";
import { IconKey } from "../../components/IconKey.js";
import { IconRefresh, IconTrash, IconX } from "../../components/Icons.js";

/** A registration's keys: reload it, remove it (confirmed in place), keep it. */
export function RegistrationActions(props: {
  busy: boolean;
  registered: boolean;
  removing: boolean;
  removeButton: RefObject<HTMLButtonElement | null>;
  onReload: () => void;
  onRemove: () => void;
  onKeep: () => void;
}) {
  return (
    <div className="actions">
      <IconKey
        label="Reload registration"
        small
        disabled={props.busy}
        onClick={props.onReload}
      >
        <IconRefresh size={16} />
      </IconKey>
      {props.registered ? (
        <>
          <IconKey
            label={props.removing ? "Confirm removal" : "Remove registration"}
            small
            danger
            keyRef={props.removeButton}
            disabled={props.busy}
            onClick={props.onRemove}
          >
            <IconTrash size={16} />
          </IconKey>
          {props.removing ? (
            <IconKey
              label="Keep registration"
              small
              disabled={props.busy}
              onClick={props.onKeep}
            >
              <IconX size={16} />
            </IconKey>
          ) : null}
        </>
      ) : null}
    </div>
  );
}
