/** Await the genuine DOM action's finally, including its worker and local vault work. */
export function clickSecurityAction(button: HTMLButtonElement): Promise<void> {
  return new Promise((resolve) => {
    const observer = new MutationObserver(() => {
      if (button.disabled) return;
      observer.disconnect();
      resolve();
    });
    observer.observe(button, {
      attributes: true,
      attributeFilter: ["disabled"],
    });
    button.click();
    if (!button.disabled) {
      observer.disconnect();
      resolve();
    }
  });
}
