import { element, sesame } from "./client.js";

const message = element("message");
try {
  const session = await sesame.complete();
  message.textContent = session
    ? `Signed in as ${session.subject}`
    : "No pending sign-in.";
} catch {
  message.textContent = "Sign-in verification failed.";
}
