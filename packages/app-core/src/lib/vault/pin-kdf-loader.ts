type PinKdfModule = typeof import("./pin-kdf.js");

let pinKdfModule: PinKdfModule | undefined;

export async function loadPinKdf(): Promise<PinKdfModule> {
  pinKdfModule ??= await import("./pin-kdf.js");
  return pinKdfModule;
}
