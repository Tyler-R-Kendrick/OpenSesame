/**
 * Installed: the files in `settings/item-types/installed/`, one row each,
 * with a key that opens the file and one that removes it — armed in place
 * before it acts — and `builtin/` folded beneath, read-only, because a
 * built-in cannot be removed (ADR 0087 §5). Removing a file never rewrites
 * the items its type shaped.
 */

import {
  BUILTIN_DIR,
  INSTALLED_DIR,
  NEW_TYPE_PATH,
  installedPath,
} from "@opensesame/app-core/sections/settings/item-type-files.js";
import {
  type VirtualFileProvider,
  baseName,
  directoryOf,
} from "@opensesame/app-core/sections/settings/virtual-files.js";
import { itemTypeRegistry } from "@opensesame/vault-core";
import type { ItemTypeDefinition } from "@opensesame/vault-item-types";
import { useState } from "react";
import { IconKey } from "../../../components/IconKey.js";
import { IconPlus, IconTrash, IconX } from "../../../components/Icons.js";
import { OpenFileKey } from "../files/OpenFileKey.js";
import { useOpenSettingsFile } from "../files/context.js";
import { TypeRow } from "./TypeRow.js";

function RemoveKeys({
  title,
  armed,
  busy,
  onArm,
  onRemove,
  onKeep,
}: {
  title: string;
  armed: boolean;
  busy: boolean;
  onArm: () => void;
  onRemove: () => void;
  onKeep: () => void;
}) {
  if (!armed) {
    return (
      <button
        type="button"
        className="icon-btn icon-btn--sm"
        disabled={busy}
        aria-label={`Remove ${title}`}
        title={`Remove ${title}`}
        onClick={onArm}
      >
        <IconTrash size={16} />
      </button>
    );
  }
  return (
    <>
      <button
        type="button"
        className="icon-btn icon-btn--sm icon-btn--danger is-armed"
        disabled={busy}
        aria-label={`Remove ${title}; its items keep their values`}
        title="Remove; items keep their values"
        onClick={onRemove}
      >
        <IconTrash size={16} />
      </button>
      <button
        type="button"
        className="icon-btn icon-btn--sm"
        aria-label={`Keep ${title}`}
        title="Keep it"
        onClick={onKeep}
      >
        <IconX size={16} />
      </button>
    </>
  );
}

function definitionsIn(
  files: VirtualFileProvider,
  directory: string,
): ItemTypeDefinition[] {
  const registry = itemTypeRegistry();
  return files
    .list()
    .filter((file) => directoryOf(file.path) === directory)
    .flatMap((file) => {
      const definition = registry.get(
        baseName(file.path).replace(/\.json$/, ""),
      );
      return definition ? [definition] : [];
    })
    .sort((a, b) => a.spec.title.localeCompare(b.spec.title));
}

/**
 * With nothing installed the list is empty and says nothing: the Marketplace
 * tab is beside it, and the one thing to do here is write a type, which is a
 * key (ADR 0158) — where a file viewer exists to write it in.
 */
function Empty() {
  const openFile = useOpenSettingsFile();
  if (!openFile) return null;
  return (
    <div className="itype-empty">
      <IconKey
        small
        label="Write a new item type"
        onClick={() => openFile(NEW_TYPE_PATH)}
      >
        <IconPlus size={16} />
      </IconKey>
    </div>
  );
}

export function InstalledTypes({
  files,
  busy,
  onRemove,
}: {
  files: VirtualFileProvider;
  busy: boolean;
  onRemove: (id: string) => void;
}) {
  const [armed, setArmed] = useState<string | null>(null);
  const installed = definitionsIn(files, INSTALLED_DIR);
  const builtin = definitionsIn(files, BUILTIN_DIR);

  return (
    <>
      {installed.length === 0 ? (
        <Empty />
      ) : (
        <ul className="itype-list" aria-label="Installed types">
          {installed.map((definition) => {
            const id = definition.metadata.id;
            const title = definition.spec.title;
            return (
              <TypeRow
                key={id}
                definition={definition}
                trailing={
                  <>
                    <OpenFileKey path={installedPath(id)} name={`${id}.json`} />
                    <RemoveKeys
                      title={title}
                      armed={armed === id}
                      busy={busy}
                      onArm={() => setArmed(id)}
                      onKeep={() => setArmed(null)}
                      onRemove={() => {
                        setArmed(null);
                        onRemove(id);
                      }}
                    />
                  </>
                }
              />
            );
          })}
        </ul>
      )}
      <details className="itype-builtin">
        <summary>
          <span>builtin/</span>
          <span className="itype-count">{builtin.length}</span>
        </summary>
        <ul
          className="itype-list itype-list--compact"
          aria-label="Built-in types"
        >
          {builtin.map((definition) => (
            <TypeRow
              key={definition.metadata.id}
              definition={definition}
              trailing={
                <OpenFileKey
                  path={`${BUILTIN_DIR}/${definition.metadata.id}.json`}
                  name={`${definition.metadata.id}.json`}
                />
              }
            />
          ))}
        </ul>
      </details>
    </>
  );
}
