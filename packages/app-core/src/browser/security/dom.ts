export function element<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  text = "",
) {
  const node = document.createElement(tag);
  node.textContent = text;
  return node;
}
export function secret(label: string) {
  const input = element("input");
  input.type = "password";
  input.autocomplete = "off";
  input.maxLength = 1024;
  const wrapper = element("label", label);
  wrapper.append(input);
  return { input, wrapper };
}
export function action(
  label: string,
  perform: () => Promise<void>,
  say: (words: string) => void,
) {
  const button = element("button", label);
  button.type = "button";
  button.addEventListener("click", () => {
    button.disabled = true;
    void perform()
      .catch((error: Error) => say(error.message))
      .finally(() => {
        button.disabled = false;
      });
  });
  return button;
}
