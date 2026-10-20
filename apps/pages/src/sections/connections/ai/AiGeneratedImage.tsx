import type { OwnedAiImage } from "@opensesame/app-core/lib/ai-connections/owned-image.js";
import { useEffect, useState } from "react";
import { FormCommit } from "../../../components/FormCommit.js";

/** Only locally decoded pixels become a ready preview or downloadable file. */
export function AiGeneratedImage({ image }: { image: OwnedAiImage }) {
  const [ready, setReady] = useState<{
    image: OwnedAiImage;
    url: string;
  } | null>(null);
  const [failed, setFailed] = useState<OwnedAiImage | null>(null);
  useEffect(() => {
    let active = true;
    let url: string | undefined;
    const decoder = new Image();
    const release = (update = true) => {
      if (!active) return;
      active = false;
      decoder.removeAttribute("src");
      if (url) URL.revokeObjectURL(url);
      image.release();
      if (update) setReady(null);
    };
    const decode = async () => {
      try {
        image.check();
        const metadata = image.metadata();
        const bytes = image.copyBytes();
        let blob: Blob;
        try {
          blob = new Blob([new Uint8Array(bytes)], { type: metadata.mimeType });
        } finally {
          bytes.fill(0);
        }
        image.check();
        url = URL.createObjectURL(blob);
        image.check();
        decoder.src = url;
        await decoder.decode();
        image.check();
        if (!active) return;
        if (
          decoder.naturalWidth !== metadata.width ||
          decoder.naturalHeight !== metadata.height
        )
          throw new Error(
            "The decoded image dimensions do not match the response.",
          );
        setReady({ image, url });
      } catch {
        if (active && !image.signal.aborted) setFailed(image);
        release();
      }
    };
    const withdraw = () => release();
    image.signal.addEventListener("abort", withdraw, { once: true });
    void decode();
    return () => {
      image.signal.removeEventListener("abort", withdraw);
      release(false);
    };
  }, [image]);
  const current = ready?.image === image ? ready : null;
  const download = () => {
    if (!current) return;
    try {
      image.check();
      const metadata = image.metadata();
      const extension =
        metadata.mimeType === "image/jpeg" ? "jpg" : metadata.mimeType.slice(6);
      const anchor = document.createElement("a");
      anchor.download = `generated-image.${extension}`;
      anchor.href = current.url;
      image.check();
      anchor.click();
    } catch {
      image.release();
      setReady(null);
    }
  };
  if (failed === image)
    return <p role="alert">The generated image could not be decoded.</p>;
  if (!current) return null;
  return (
    <div>
      <img
        src={current.url}
        alt="Generated artwork"
        style={{ maxWidth: "100%", height: "auto" }}
      />
      <FormCommit label="Download image" onClick={download} />
    </div>
  );
}
