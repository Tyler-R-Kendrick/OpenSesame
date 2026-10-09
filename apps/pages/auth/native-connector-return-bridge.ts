import { runNativeAuthReturn } from "@opensesame/app-core/browser/native-auth-return.js";

// The consent window never boots another vault session or puts the code into
// an application URL. Its one recipient is the tab that started this state.
function expired(): void {
  const status = document.querySelector("p");
  if (status)
    status.textContent = "Sign-in expired. Close this window and try again.";
}
void runNativeAuthReturn()
  .then((delivered) => {
    if (!delivered) expired();
  })
  .catch(expired);
