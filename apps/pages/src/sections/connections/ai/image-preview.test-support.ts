import { vi } from "vitest";

type PendingDecode = {
  image: HTMLImageElement;
  resolve(): void;
  reject(reason: Error): void;
};
/** Controlled browser decoder/URL host APIs; the component and saved owner are real. */
export function previewHost() {
  const descriptors = Object.getOwnPropertyDescriptors(
    HTMLImageElement.prototype,
  );
  const create = Object.getOwnPropertyDescriptor(URL, "createObjectURL");
  const revoke = Object.getOwnPropertyDescriptor(URL, "revokeObjectURL");
  const pending: PendingDecode[] = [];
  const urls: Blob[] = [];
  const revoked: string[] = [];
  Object.defineProperties(HTMLImageElement.prototype, {
    decode: {
      configurable: true,
      value(this: HTMLImageElement) {
        return new Promise<void>((resolve, reject) =>
          pending.push({ image: this, resolve, reject }),
        );
      },
    },
    naturalWidth: {
      configurable: true,
      get() {
        return 2;
      },
    },
    naturalHeight: {
      configurable: true,
      get() {
        return 3;
      },
    },
  });
  Object.defineProperties(URL, {
    createObjectURL: {
      configurable: true,
      value(blob: Blob) {
        urls.push(blob);
        return `blob:owned-image-${urls.length}`;
      },
    },
    revokeObjectURL: {
      configurable: true,
      value(url: string) {
        revoked.push(url);
      },
    },
  });
  const clicked: { href: string; filename: string }[] = [];
  const click = vi
    .spyOn(HTMLAnchorElement.prototype, "click")
    .mockImplementation(function (this: HTMLAnchorElement) {
      clicked.push({ href: this.href, filename: this.download });
    });
  return {
    pending,
    urls,
    revoked,
    clicked,
    close() {
      for (const name of ["decode", "naturalWidth", "naturalHeight"]) {
        const original = descriptors[name];
        if (original)
          Object.defineProperty(HTMLImageElement.prototype, name, original);
        else Reflect.deleteProperty(HTMLImageElement.prototype, name);
      }
      for (const [name, original] of [
        ["createObjectURL", create],
        ["revokeObjectURL", revoke],
      ] as const) {
        if (original) Object.defineProperty(URL, name, original);
        else Reflect.deleteProperty(URL, name);
      }
      click.mockRestore();
    },
  };
}
