import { type ChangeEvent, useId, useState } from "react";
import { z } from "zod";
import { IconTrash } from "../../../components/Icons.js";

const MAX_BYTES = 2 * 1024 * 1024;
const IconUrl = z
  .string()
  .regex(/^data:image\/(png|jpeg);base64,[A-Za-z0-9+/]+={0,2}$/);

function readFile(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const parsed = IconUrl.safeParse(reader.result);
      if (parsed.success) resolve(parsed.data);
      else reject(new Error("The icon could not be read."));
    };
    reader.onerror = () => reject(new Error("The icon could not be read."));
    reader.readAsDataURL(file);
  });
}

async function iconFrom(file: File): Promise<string> {
  if (!["image/png", "image/jpeg"].includes(file.type)) {
    throw new Error("Choose a PNG or JPG icon.");
  }
  if (file.size > MAX_BYTES) throw new Error("The icon must be at most 2 MB.");
  const url = await readFile(file);
  await new Promise<void>((resolve, reject) => {
    const image = new Image();
    image.onload = () =>
      image.naturalWidth >= 640 && image.naturalHeight >= 640
        ? resolve()
        : reject(new Error("The icon must be at least 640 × 640 pixels."));
    image.onerror = () => reject(new Error("Choose a valid PNG or JPG icon."));
    image.src = url;
  });
  return url;
}

export function ConnectorIconField({
  value,
  onChange,
  onError,
  onBusyChange,
}: {
  value: string;
  onChange: (next: string) => void;
  onError: (message: string) => void;
  onBusyChange?: (busy: boolean) => void;
}) {
  const id = useId();
  const [busy, setBusy] = useState(false);
  async function upload(event: ChangeEvent<HTMLInputElement>) {
    const input = event.currentTarget;
    const file = input.files?.[0];
    if (!file) return;
    setBusy(true);
    onBusyChange?.(true);
    try {
      onChange(await iconFrom(file));
    } catch (error) {
      onError(
        error instanceof Error ? error.message : "The icon could not be read.",
      );
    } finally {
      input.value = "";
      setBusy(false);
      onBusyChange?.(false);
    }
  }
  return (
    <div className="cx-icon-field" aria-busy={busy}>
      <label className="f__label" htmlFor={id}>
        Icon
      </label>
      <div className="cx-icon-field__row">
        {value ? (
          <img src={value} alt="Connector icon" width={44} height={44} />
        ) : null}
        <input
          id={id}
          type="file"
          disabled={busy}
          accept="image/png,image/jpeg"
          aria-label="Icon"
          title="PNG or JPG, at least 640 × 640 pixels, at most 2 MB"
          onChange={(event) => void upload(event)}
        />
        {value ? (
          <button
            type="button"
            disabled={busy}
            className="icon-btn"
            aria-label="Remove icon"
            title="Remove icon"
            onClick={() => onChange("")}
          >
            <IconTrash size={16} />
          </button>
        ) : null}
      </div>
    </div>
  );
}
