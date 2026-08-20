import { encodeQrSvg as encodeQrSvgDefault } from "@opensesame/qr";
import { useMemo } from "react";

type QrCodeProps = {
  value: string;
  /** Accessible description of what scanning does. */
  label: string;
  /** Optional shortcode caption under the QR (e.g. device user code). */
  shortcode?: string;
  /** CSS pixel size of the rendered square. Default 144. */
  size?: number;
  className?: string;
};

function QrCodeDefault({
  value,
  label,
  shortcode,
  size = 144,
  className,
}: QrCodeProps) {
  const src = useMemo(() => {
    const trimmed = value.trim();
    if (!trimmed) return null;
    try {
      const svg = qrSeams.encodeQrSvg(trimmed, { pixelSize: 4, border: 2 });
      return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
    } catch {
      return null;
    }
  }, [value]);

  if (!src) return null;

  return (
    <figure className={className ? `qr ${className}` : "qr"}>
      <img
        className="qr__img"
        src={src}
        width={size}
        height={size}
        alt={label}
      />
      {shortcode ? (
        <figcaption className="qr__caption">
          <span className="qr__shortcode">{shortcode}</span>
        </figcaption>
      ) : null}
    </figure>
  );
}

export const qrSeams = {
  encodeQrSvg: encodeQrSvgDefault,
  QrCode: QrCodeDefault,
};

/** Inline QR via data-URL SVG. Empty values render nothing. */
export function QrCode(props: QrCodeProps) {
  const Impl = qrSeams.QrCode;
  return <Impl {...props} />;
}
