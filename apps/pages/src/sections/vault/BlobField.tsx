import { defaultFileStores } from "@opensesame/app-core/lib/file-parts-store.js";
import {
  MAX_FILE_BYTES,
  fileSummary,
  openFile,
  sealFile,
} from "@opensesame/vault-core";
import { type ReactNode, useRef } from "react";
import { FieldRow } from "../../components/FieldRow.js";
import { IconDownload, IconUpload } from "../../components/Icons.js";

function iconKey(label: string, onClick: () => void, icon: ReactNode) {
  return (
    <button
      type="button"
      className="icon-btn"
      aria-label={label}
      title={label}
      onClick={onClick}
    >
      {icon}
    </button>
  );
}

function formatFileSize(size: number): string {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  if (size < 1024 * 1024 * 1024)
    return `${(size / (1024 * 1024)).toFixed(1)} MB`;
  return `${(size / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

async function sealPicked(file: File): Promise<string> {
  if (file.size > MAX_FILE_BYTES)
    throw new Error("file exceeds the size limit");
  const bytes = new Uint8Array(await file.arrayBuffer());
  const mediaType = file.type === "" ? "application/octet-stream" : file.type;
  return sealFile({
    name: file.name,
    mediaType,
    bytes,
    stores: await defaultFileStores(),
  });
}

export function BlobInput({
  id,
  value,
  onChange,
}: {
  id: string;
  value: string;
  onChange: (next: string) => void;
}) {
  const input = useRef<HTMLInputElement>(null);
  const summary = fileSummary(value);
  const name = summary === null || summary.name === "" ? "" : summary.name;
  return (
    <div className="editor__inline">
      {iconKey(
        "Choose file",
        () => input.current?.click(),
        <IconUpload size={15} />,
      )}
      <input
        ref={input}
        id={id}
        type="file"
        hidden
        onChange={(event) => {
          const picked = event.target.files?.[0];
          event.target.value = "";
          if (picked === undefined) return;
          void sealPicked(picked).then(onChange, () => undefined);
        }}
      />
      {name === "" ? null : <span className="frow__value">{name}</span>}
    </div>
  );
}

async function saveFile(manifest: string): Promise<void> {
  const summary = fileSummary(manifest);
  if (summary === null) return;
  const opened = await openFile(manifest, await defaultFileStores());
  const blob = new Blob([opened.bytes], { type: opened.mediaType });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = summary.name === "" ? "file" : summary.name;
  anchor.click();
  URL.revokeObjectURL(url);
}

export function BlobRow({
  manifest,
  label,
}: { manifest: string; label: string }) {
  const summary = fileSummary(manifest);
  if (summary === null) return null;
  const name = summary.name === "" ? "File" : summary.name;
  return (
    <FieldRow
      label={label}
      actions={iconKey(
        "Download file",
        () => void saveFile(manifest),
        <IconDownload size={15} />,
      )}
    >
      <span className="frow__value">
        {name} · {formatFileSize(summary.size)}
      </span>
    </FieldRow>
  );
}
