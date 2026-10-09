/** Provider consent returns before identity bootstrap and uses its own parameter namespace. */
const callback = new URL(window.location.href);
const destination = new URL("../connections", callback);
destination.searchParams.set("native_callback", "1");
for (const name of ["code", "state", "error"] as const) {
  for (const value of callback.searchParams.getAll(name)) {
    destination.searchParams.append(`native_${name}`, value);
  }
}
window.history.replaceState(null, "", callback.pathname);
window.location.replace(destination.href);
