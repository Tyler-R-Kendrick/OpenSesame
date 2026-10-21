import type { HostedModelRuntime } from "../hosted-inference.js";
import type { AiImageOutput } from "./image-output.js";
import { captureImageOwnerContext } from "./image-owner-context.js";
import { AiConnectionError } from "./types.js";

type ImageContext = Awaited<ReturnType<typeof captureImageOwnerContext>>;
/** One local raster owned by the original saved connection, independent of HTTP close. */
export class OwnedAiImage {
  #image: AiImageOutput | null = null;
  #completed = false;
  #released = false;
  private constructor(private readonly context: Omit<ImageContext, "draft">) {
    context.signal.addEventListener("abort", () => this.release(), {
      once: true,
    });
  }
  static async prepare(
    id: string,
    caller: Pick<HostedModelRuntime, "signal" | "assertCurrent">,
  ) {
    const { draft, ...context } = await captureImageOwnerContext(id, caller);
    const owner = new OwnedAiImage(context);
    try {
      owner.check();
      return {
        owner,
        draft,
        transport: Object.freeze({ ...context.port, signal: context.signal }),
      };
    } catch (error) {
      owner.release();
      throw error;
    }
  }
  get signal(): AbortSignal {
    return this.context.signal;
  }
  check(): void {
    if (this.#released)
      throw new AiConnectionError("stale", "The generated image was released.");
    try {
      this.context.check();
    } catch (error) {
      this.release();
      throw error;
    }
  }
  /** Called exactly once after inference's final original-owner check. */
  complete(image: AiImageOutput): OwnedAiImage {
    try {
      this.check();
      if (this.#completed)
        throw new AiConnectionError(
          "stale",
          "This image operation already completed.",
        );
      this.#completed = true;
      this.#image = image;
      this.check();
      return this;
    } catch (error) {
      image.release();
      this.release();
      throw error;
    }
  }
  metadata() {
    this.check();
    if (!this.#image)
      throw new AiConnectionError("response", "The image has not completed.");
    const { mimeType, width, height, seed } = this.#image;
    return { mimeType, width, height, seed };
  }
  copyBytes(): Uint8Array {
    this.check();
    if (!this.#image)
      throw new AiConnectionError("response", "The image has not completed.");
    const bytes = this.#image.copyBytes();
    try {
      this.check();
      return bytes;
    } catch (error) {
      bytes.fill(0);
      throw error;
    }
  }
  release(): void {
    if (this.#released) return;
    this.#released = true;
    this.#image?.release();
    this.#image = null;
    this.context.close();
  }
}
