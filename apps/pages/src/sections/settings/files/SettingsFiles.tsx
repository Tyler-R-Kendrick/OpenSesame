/**
 * The files a settings directory's providers keep for authoring — for
 * Vaults, the item types. The directory's own document and the capability
 * documents are not here: they are the page (`documents.ts`). The list is the
 * files as paths; the pane beside it is the one that is open.
 */

import {
  type VirtualFile,
  type VirtualFileProvider,
  baseName,
  directoryOf,
} from "@opensesame/app-core/sections/settings/virtual-files.js";
import type { CSSProperties } from "react";
import { IconLock, IconPlus } from "../../../components/Icons.js";
import { VirtualFileEditor } from "./VirtualFileEditor.js";
import { isSettingsDocument } from "./documents.js";
import { useCategoryFiles } from "./providers.js";
import "./settings-files.css";

type Group = { directory: string; files: VirtualFile[] };

function groups(files: readonly VirtualFile[]): Group[] {
  const out: Group[] = [];
  for (const file of files) {
    const directory = directoryOf(file.path);
    const group = out.find((entry) => entry.directory === directory);
    if (group) group.files.push(file);
    else out.push({ directory, files: [file] });
  }
  return out;
}

/** A directory sits under its parent, a step in per level, like the rail. */
function depthOf(directory: string): CSSProperties {
  return { paddingLeft: `${(directory.split("/").length - 1) * 0.9}rem` };
}

/** The directory new files go in is listed even while it is empty. */
function withCreates(list: Group[], directory: string | undefined): Group[] {
  if (directory === undefined || list.some((g) => g.directory === directory))
    return list;
  const at = list.findIndex((g) => g.files.every((file) => file.readOnly));
  const next = [...list];
  next.splice(at < 0 ? next.length : at, 0, { directory, files: [] });
  return next;
}

function FileRow({
  file,
  selected,
  onSelect,
}: {
  file: VirtualFile;
  selected: boolean;
  onSelect: (path: string) => void;
}) {
  return (
    <li>
      <button
        type="button"
        className={`vfiles__file${selected ? " is-open" : ""}`}
        aria-current={selected ? "true" : undefined}
        onClick={() => onSelect(file.path)}
      >
        <span>{baseName(file.path)}</span>
        {file.readOnly ? (
          <span
            className="vfiles__ro"
            role="img"
            aria-label="read-only"
            title="read-only"
          >
            <IconLock size={11} />
          </span>
        ) : null}
      </button>
    </li>
  );
}

function FileList({
  files,
  selected,
  creates,
  onSelect,
}: {
  files: readonly VirtualFile[];
  selected: string;
  creates: VirtualFileProvider["creates"];
  onSelect: (path: string) => void;
}) {
  return (
    <nav className="vfiles__list" aria-label="Files">
      {withCreates(groups(files), creates?.directory).map(
        ({ directory, files: inDirectory }) => {
          const readOnly =
            inDirectory.length > 0 &&
            inDirectory.every((file) => file.readOnly);
          const open = !readOnly || directory === directoryOf(selected);
          const rows = (
            <ul>
              {inDirectory.map((file) => (
                <FileRow
                  key={file.path}
                  file={file}
                  selected={file.path === selected}
                  onSelect={onSelect}
                />
              ))}
            </ul>
          );
          const head = (
            <>
              <span title={`${directory}/`}>{baseName(directory)}/</span>
              <span className="vfiles__count">{inDirectory.length}</span>
            </>
          );
          if (readOnly)
            return (
              <details
                key={directory}
                className="vfiles__dir"
                style={depthOf(directory)}
                open={open}
              >
                <summary className="vfiles__dirname">{head}</summary>
                {rows}
              </details>
            );
          return (
            <div
              key={directory}
              className="vfiles__dir"
              style={depthOf(directory)}
            >
              <div className="vfiles__dirname">
                {head}
                {creates?.directory === directory ? (
                  <button
                    type="button"
                    className="icon-btn icon-btn--sm"
                    aria-label={`New file in ${directory}/`}
                    title="New file"
                    onClick={() => onSelect(creates.draftPath)}
                  >
                    <IconPlus size={14} />
                  </button>
                ) : null}
              </div>
              {rows}
            </div>
          );
        },
      )}
    </nav>
  );
}

export function SettingsFiles({
  category,
  selected,
  onSelect,
}: {
  /** A core category, or one a capability contributed. */
  category: string;
  /** The `?file=` value: a path the category's provider keeps. */
  selected: string;
  onSelect: (file: string | null) => void;
}) {
  const provider = useCategoryFiles(category);
  if (provider === null) return null;
  const listed = provider
    .list()
    .filter((file) => !isSettingsDocument(category, file.path));
  const draft = provider.creates?.draftPath;
  const open =
    listed.find((file) => file.path === selected) ??
    (selected === draft && draft !== undefined
      ? {
          path: draft,
          language: "json" as const,
          readOnly: false,
          removable: false,
        }
      : listed[0]);
  if (open === undefined) return null;

  return (
    <div className="vfiles">
      <FileList
        files={listed}
        selected={open.path}
        creates={provider.creates}
        onSelect={onSelect}
      />
      <div className="vfiles__open">
        <VirtualFileEditor
          key={open.path}
          file={open}
          files={provider}
          initial={open.path === draft ? provider.creates?.template : undefined}
          onMoved={(path) => onSelect(path)}
        />
      </div>
    </div>
  );
}
