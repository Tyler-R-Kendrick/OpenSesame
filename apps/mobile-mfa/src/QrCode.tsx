import { encodeQrSvg } from "@opensesame/qr";
import { useMemo } from "react";

export function QrCode({
  value,
  label,
  size = 160,
}: {
  value: string;
  label: string;
  size?: number;
}) {
  const src = useMemo(() => {
    const trimmed = value.trim();
    if (!trimmed) return null;
    try {
      const svg = encodeQrSvg(trimmed, { pixelSize: 4, border: 2 });
      return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
    } catch {
      return null;
    }
  }, [value]);

  if (!src) return null;
  return (
    <img
      className="qr"
      src={src}
      width={size}
      height={size}
      alt={label}
    />
  );
}
