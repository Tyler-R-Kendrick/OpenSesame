/** Real Node resizable buffers without augmenting the application's ES2022 types. */
import { isFunction, overlapCast } from "@opensesame/os-domain";

interface ResizableArrayBuffer extends ArrayBuffer {
  readonly resizable: true;
  readonly maxByteLength: number;
  resize(size: number): void;
}

export function resizableArrayBuffer(
  byteLength: number,
  maxByteLength: number,
) {
  const buffer: ArrayBuffer = Reflect.construct(ArrayBuffer, [
    byteLength,
    { maxByteLength },
  ]);
  const resize = Object.getOwnPropertyDescriptor(
    ArrayBuffer.prototype,
    "resize",
  )?.value;
  if (
    !(buffer instanceof ArrayBuffer) ||
    !("resizable" in buffer) ||
    buffer.resizable !== true ||
    !("maxByteLength" in buffer) ||
    buffer.maxByteLength !== maxByteLength ||
    !("resize" in buffer) ||
    buffer.resize !== resize ||
    !isFunction(resize)
  ) {
    throw new Error(
      "These security regressions require resizable ArrayBuffers.",
    );
  }
  // SAFETY: the real native buffer, resizable mode, requested maximum and
  // callable native method were checked above. ES2022 libs omit this runtime API.
  const validated: ResizableArrayBuffer = overlapCast(buffer);
  return {
    buffer: validated,
    resize(size: number): void {
      validated.resize(size);
    },
  };
}
