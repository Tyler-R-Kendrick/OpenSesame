import { runNativeImplicitReturn } from "@opensesame/app-core/browser/native-implicit-return.js";
void runNativeImplicitReturn().catch(() => {
  const status = document.querySelector("p");
  if (status)
    status.textContent =
      "Return expired. Close this window and retry in the original connection.";
});
