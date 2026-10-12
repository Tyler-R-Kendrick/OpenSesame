import {
  type NativeAuthAcknowledgement,
  captureNativeAuthCode,
  nativeAuthCallbackUrl,
  nativeAuthChannel,
  nativeAuthRandom,
  parseNativeAuthAcknowledgement,
} from "./native-auth-message.js";

/** Runs on the registered static page, before any vault or identity app boots. */
export async function runNativeAuthReturn(): Promise<boolean> {
  const callback = new URL(window.location.href);
  const response = captureNativeAuthCode(callback);
  window.history.replaceState(null, "", callback.pathname);
  if (!response || !globalThis.BroadcastChannel) return false;
  callback.search = "";
  callback.hash = "";
  const redirectUri = nativeAuthCallbackUrl(callback.href);
  const channel = new BroadcastChannel(await nativeAuthChannel(response.state));
  const receipt = nativeAuthRandom();
  return new Promise((resolve) => {
    const finish = (delivered: boolean) => {
      clearTimeout(deadline);
      channel.close();
      resolve(delivered);
      if (delivered) window.close();
    };
    const deadline = setTimeout(() => finish(false), 2500);
    channel.onmessage = (event: MessageEvent<NativeAuthAcknowledgement>) => {
      const response = parseNativeAuthAcknowledgement(event.data);
      if (response?.receipt === receipt) finish(true);
    };
    channel.postMessage({
      kind: "authorization-code",
      redirectUri,
      receipt,
      ...response,
    });
  });
}
