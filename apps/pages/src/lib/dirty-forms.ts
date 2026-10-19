/**
 * An edit surface with a value the person has changed and not committed.
 *
 * The snapshot is taken on the event, in the capture phase, before React
 * copies the live value onto `defaultValue`. Reading `defaultValue` after the
 * commit would say a controlled field was clean and a release change would
 * reload over the edit. Returning to that snapshot (undo) is clean again.
 * Checkboxes outside an editor persist on their own and do not count.
 */

import { holdDirtyEdit } from "@opensesame/app-core/lib/dirty-edit.js";
import { useEffect } from "react";

const TEXT_TYPES = new Set([
  "",
  "email",
  "number",
  "password",
  "search",
  "tel",
  "text",
  "url",
]);

const snapshots = new WeakMap<Element, string>();
const releases = new Map<HTMLFormElement, () => void>();
let nextId = 0;

function readValue(el: Element): string | null {
  if (el instanceof HTMLTextAreaElement) return el.value;
  if (el instanceof HTMLSelectElement) {
    return [...el.selectedOptions].map((option) => option.value).join("\0");
  }
  if (!(el instanceof HTMLInputElement)) return null;
  if (el.type === "checkbox" || el.type === "radio") {
    return el.checked ? "1" : "0";
  }
  if (!TEXT_TYPES.has(el.type)) return null;
  return el.value;
}

function baseline(el: Element): string | null {
  if (el instanceof HTMLTextAreaElement) return el.defaultValue;
  if (el instanceof HTMLSelectElement) {
    return [...el.options]
      .filter((option) => option.defaultSelected)
      .map((option) => option.value)
      .join("\0");
  }
  if (!(el instanceof HTMLInputElement)) return null;
  if (el.type === "checkbox" || el.type === "radio") {
    return el.defaultChecked ? "1" : "0";
  }
  if (!TEXT_TYPES.has(el.type)) return null;
  return el.defaultValue;
}

/** A form whose fields are an edit, not a transient filter or a switch row. */
function isSurface(form: HTMLFormElement): boolean {
  if (form.hasAttribute("data-transient")) return false;
  if (form.classList.contains("editor")) return true;
  if (form.hasAttribute("data-edit-surface")) return true;
  return (
    form.querySelector(
      "button.go, button[type='submit'], input[type='submit']",
    ) !== null
  );
}

function counts(el: Element, form: HTMLFormElement): boolean {
  if (
    el instanceof HTMLInputElement &&
    (el.type === "checkbox" || el.type === "radio")
  ) {
    return (
      form.classList.contains("editor") ||
      form.hasAttribute("data-edit-surface")
    );
  }
  return readValue(el) !== null;
}

function formOf(target: EventTarget | null): HTMLFormElement | null {
  if (!(target instanceof Element)) return null;
  const form = target.closest("form");
  if (!(form instanceof HTMLFormElement) || !isSurface(form)) return null;
  return form;
}

function refresh(form: HTMLFormElement): void {
  let dirty = false;
  for (const el of form.querySelectorAll("input, textarea, select")) {
    if (!counts(el, form)) continue;
    const snap = snapshots.get(el);
    if (snap !== undefined && readValue(el) !== snap) dirty = true;
  }
  if (dirty) {
    if (!releases.has(form)) {
      releases.set(form, holdDirtyEdit(`form:${nextId}`));
      nextId += 1;
    }
    return;
  }
  releases.get(form)?.();
  releases.delete(form);
}

function forget(form: HTMLFormElement): void {
  for (const el of form.querySelectorAll("input, textarea, select")) {
    snapshots.delete(el);
  }
  releases.get(form)?.();
  releases.delete(form);
}

function note(el: Element, form: HTMLFormElement): void {
  if (!counts(el, form)) return;
  if (!snapshots.has(el)) {
    const base = baseline(el);
    if (base === null) return;
    snapshots.set(el, base);
  }
  refresh(form);
}

function onEdit(event: Event): void {
  const target = event.target;
  if (!(target instanceof Element)) return;
  const form = formOf(target);
  if (!form) return;
  note(target, form);
}

function onReset(event: Event): void {
  if (event.target instanceof HTMLFormElement) forget(event.target);
}

function onCommit(event: Event): void {
  const target = event.target;
  const form =
    target instanceof HTMLFormElement
      ? target
      : target instanceof Element
        ? target.closest("form")
        : null;
  if (form instanceof HTMLFormElement) forget(form);
}

/** Watch edit surfaces under `root`. The returned function removes the watch. */
export function watchDirtyForms(root: ParentNode = document): () => void {
  const doc = root instanceof Document ? root : root.ownerDocument;
  if (!doc) return () => undefined;
  const observer = new MutationObserver((records) => {
    for (const record of records) {
      for (const node of record.removedNodes) {
        if (!(node instanceof Element)) continue;
        const forms =
          node instanceof HTMLFormElement
            ? [node]
            : [...node.querySelectorAll("form")];
        for (const form of forms) forget(form);
      }
    }
  });
  doc.addEventListener("input", onEdit, true);
  doc.addEventListener("change", onEdit, true);
  doc.addEventListener("reset", onReset, true);
  doc.addEventListener("os-edit-committed", onCommit);
  observer.observe(doc.documentElement, { childList: true, subtree: true });
  return () => {
    doc.removeEventListener("input", onEdit, true);
    doc.removeEventListener("change", onEdit, true);
    doc.removeEventListener("reset", onReset, true);
    doc.removeEventListener("os-edit-committed", onCommit);
    observer.disconnect();
  };
}

/** Installed once for the life of the app root, unlock screen included. */
export function useDirtyFormWatch(): void {
  useEffect(() => watchDirtyForms(), []);
}
