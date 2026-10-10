import { runNativeAuthReturn } from "@opensesame/app-core/browser/native-auth-return.js";

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
