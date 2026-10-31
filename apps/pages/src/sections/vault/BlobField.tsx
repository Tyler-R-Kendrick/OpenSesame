import { defaultFileStores } from "@opensesame/app-core/lib/file-parts-store.js";
import {
  MAX_FILE_BYTES,
  fileSummary,
  openFile,
  sealFile,
} from "@opensesame/vault-core";
import { type ReactNode, useRef, useState } from "react";
import { FieldRow } from "../../components/FieldRow.js";
import { IconDownload, IconUpload } from "../../components/Icons.js";
import {
  originPrivateFilesAvailable,
  pickFiles,
  saveBlob,
} from "../../lib/file-system.js";
import { asBufferSource } from "@opensesame/os-domain";

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
  const [error, setError] = useState<string | null>(null);
  const summary = fileSummary(value);
  const accept = (picked: File) => {
    if (!originPrivateFilesAvailable()) {
      setError("This browser cannot store file attachments.");
      return;
    }
    setError(null);
    void sealPicked(picked).then(
      (manifest) => {
        setError(null);
        onChange(manifest);
      },
      () => setError("Could not store that file."),
    );
  };
  const choose = () => {
    void pickFiles().then(
      (files) => {
        if (files === null) input.current?.click();
        else if (files[0]) accept(files[0]);
      },
      () => input.current?.click(),
    );
  };
  const name = summary === null || summary.name === "" ? "" : summary.name;
  return (
    <div className="editor__inline">
      {iconKey("Choose file", choose, <IconUpload size={15} />)}
      <input
        ref={input}
        id={id}
        type="file"
        hidden
        onChange={(event) => {
          const picked = event.target.files?.[0];
          event.target.value = "";
          if (picked !== undefined) accept(picked);
        }}
      />
      {name === "" ? null : <span className="frow__value">{name}</span>}
      {error === null ? null : <span role="alert">{error}</span>}
    </div>
  );
}

async function saveFile(manifest: string): Promise<void> {
  const summary = fileSummary(manifest);
  if (summary === null) return;
  const opened = await openFile(manifest, await defaultFileStores());
  const blob = new Blob([asBufferSource(opened.bytes)], { type: opened.mediaType });
  await saveBlob(blob, summary.name === "" ? "file" : summary.name, "File");
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
