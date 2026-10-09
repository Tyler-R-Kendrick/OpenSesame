/** Keep provider consent distinct from identity sign-in before the app boots. */
const callback = new URL(window.location.href);
const destination = new URL("../connections/linear", callback);
for (const name of ["code", "state", "error"] as const) {
  for (const value of callback.searchParams.getAll(name)) {
    destination.searchParams.append(`linear_${name}`, value);
  }
}
window.history.replaceState(null, "", callback.pathname);
window.location.replace(destination.href);
