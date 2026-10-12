/**
 * A 2D context for jsdom, which has none: every call the wordmark makes is a
 * no-op that records nothing, `measureText` answers a mono advance, and
 * `getImageData` is empty coverage (so every particle survives its mask).
 * Tests install it on `HTMLCanvasElement.prototype.getContext`.
 */
export function stubCanvas2d(): void {
  const noop = () => {};
  const make = (canvas: HTMLCanvasElement) => {
    const ctx = {
      canvas,
      fillStyle: "#000",
      strokeStyle: "#000",
      lineWidth: 1,
      font: "",
      textAlign: "left",
      textBaseline: "alphabetic",
      globalCompositeOperation: "source-over",
      setTransform: noop,
      clearRect: noop,
      fillRect: noop,
      strokeRect: noop,
      fillText: noop,
      strokeText: noop,
      beginPath: noop,
      rect: noop,
      arc: noop,
      moveTo: noop,
      lineTo: noop,
      fill: noop,
      stroke: noop,
      save: noop,
      restore: noop,
      translate: noop,
      rotate: noop,
      drawImage: noop,
      measureText: (text: string) => {
        const size = Number.parseFloat(ctx.font) || 16;
        return {
          width: text.length * size * 0.6,
          actualBoundingBoxAscent: size * 0.72,
          actualBoundingBoxLeft: 0,
          actualBoundingBoxRight: size * 0.6,
        };
      },
      getImageData: (_x: number, _y: number, w: number, h: number) => ({
        data: new Uint8ClampedArray(w * h * 4),
        width: w,
        height: h,
      }),
    };
    return ctx;
  };
  Object.defineProperty(HTMLCanvasElement.prototype, "getContext", {
    configurable: true,
    writable: true,
    value: function getContext(this: HTMLCanvasElement) {
      return make(this);
    },
  });
}
