/* =====================================================================
   Dialogs.

   Replaces window.confirm and window.prompt. Those cannot be styled,
   they block the whole tab, they render differently in every browser,
   and on a phone they arrive as a system sheet headed with the domain
   name — which reads like a security warning rather than a question
   about a dance lesson.

   Promise-based, so calling code reads the same as it did before:

       if (!await confirmDialog({ title: "Cancel?" })) return;
   ===================================================================== */

import { el } from "./ui.js";

export type DialogTone = "primary" | "danger";

export interface ConfirmOptions {
  title: string;
  message?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  tone?: DialogTone;
}

export interface PromptOptions extends ConfirmOptions {
  label: string;
  value?: string;
  /** Native input type — "time" gives phones their own wheel picker. */
  inputType?: string;
  step?: string;
  placeholder?: string;
}

function host(): HTMLElement {
  let node = document.getElementById("dialogHost");
  if (!node) {
    node = el("div");
    node.id = "dialogHost";
    document.body.append(node);
  }
  return node;
}

interface Built {
  overlay: HTMLElement;
  card: HTMLElement;
  actions: HTMLElement;
  close: (value: unknown) => void;
  settle: Promise<unknown>;
}

function build(options: ConfirmOptions): Built {
  const overlay = el("div", "dialog-overlay");
  overlay.setAttribute("role", "dialog");
  overlay.setAttribute("aria-modal", "true");

  const card = el("div", "dialog-card");
  const heading = el("h2", "dialog-title", options.title);
  heading.id = `dialog-title-${Math.random().toString(36).slice(2, 8)}`;
  overlay.setAttribute("aria-labelledby", heading.id);
  card.append(heading);

  if (options.message) card.append(el("p", "dialog-message", options.message));

  const actions = el("div", "dialog-actions");
  card.append(actions);
  overlay.append(card);

  // Whatever had focus should get it back, or a keyboard user is
  // dumped at the top of the document when the dialog closes.
  const previouslyFocused = document.activeElement as HTMLElement | null;

  let resolve!: (value: unknown) => void;
  const settle = new Promise<unknown>(r => { resolve = r; });

  const close = (value: unknown) => {
    document.removeEventListener("keydown", onKey, true);
    overlay.classList.add("closing");
    // Let the exit animation run before the node goes.
    setTimeout(() => overlay.remove(), 150);
    previouslyFocused?.focus?.();
    resolve(value);
  };

  function onKey(event: KeyboardEvent): void {
    if (event.key === "Escape") {
      event.preventDefault();
      close(null);
      return;
    }
    if (event.key !== "Tab") return;

    // Keep Tab inside the dialog; behind it the page is inert.
    const focusable = [...card.querySelectorAll<HTMLElement>(
      "button, [href], input, select, textarea, [tabindex]:not([tabindex='-1'])"
    )].filter(node => !node.hasAttribute("disabled"));
    if (focusable.length === 0) return;

    const first = focusable[0]!;
    const last = focusable[focusable.length - 1]!;
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }

  document.addEventListener("keydown", onKey, true);
  // Only a click on the backdrop itself dismisses; one that started
  // inside the card and drifted out must not.
  overlay.addEventListener("mousedown", event => {
    if (event.target === overlay) close(null);
  });

  return { overlay, card, actions, close, settle };
}

/** Ask a yes/no question. Resolves false on Escape or backdrop. */
export function confirmDialog(options: ConfirmOptions): Promise<boolean> {
  const built = build(options);

  const cancel = el("button", "btn ghost", options.cancelLabel ?? "Cancel");
  cancel.type = "button";
  cancel.addEventListener("click", () => built.close(false));

  const confirm = el("button", `btn ${options.tone === "danger" ? "danger" : "primary"}`,
    options.confirmLabel ?? "Confirm");
  confirm.type = "button";
  confirm.addEventListener("click", () => built.close(true));

  built.actions.append(cancel, confirm);
  host().append(built.overlay);
  requestAnimationFrame(() => confirm.focus());

  return built.settle.then(value => value === true);
}

export interface ChoiceOption {
  value: string;
  label: string;
  tone?: DialogTone;
}

export interface ChoiceOptions extends ConfirmOptions {
  options: ChoiceOption[];
}

/**
 * Pick one of several actions. Resolves null when dismissed.
 *
 * For questions where yes/no would be a lie — cancelling one week of a
 * weekly booking versus ending the whole series are different requests,
 * and a confirm dialog can only ask one of them.
 */
export function choiceDialog(options: ChoiceOptions): Promise<string | null> {
  const built = build(options);
  built.actions.classList.add("dialog-actions-stacked");

  for (const option of options.options) {
    const button = el("button", `btn ${option.tone === "danger" ? "danger" : "primary"}`, option.label);
    button.type = "button";
    button.addEventListener("click", () => built.close(option.value));
    built.actions.append(button);
  }

  const cancel = el("button", "btn ghost", options.cancelLabel ?? "Keep it");
  cancel.type = "button";
  cancel.addEventListener("click", () => built.close(null));
  built.actions.append(cancel);

  host().append(built.overlay);
  requestAnimationFrame(() => built.actions.querySelector("button")?.focus());

  return built.settle.then(value => (typeof value === "string" ? value : null));
}

/** Ask for a value. Resolves null when dismissed. */
export function promptDialog(options: PromptOptions): Promise<string | null> {
  const built = build(options);

  const field = el("div", "field");
  const label = el("label", "field-label", options.label);
  const input = el("input");
  input.type = options.inputType ?? "text";
  input.value = options.value ?? "";
  if (options.step) input.step = options.step;
  if (options.placeholder) input.placeholder = options.placeholder;
  const id = `dialog-input-${Math.random().toString(36).slice(2, 8)}`;
  input.id = id;
  label.htmlFor = id;
  field.append(label, input);
  built.card.insertBefore(field, built.actions);

  const cancel = el("button", "btn ghost", options.cancelLabel ?? "Cancel");
  cancel.type = "button";
  cancel.addEventListener("click", () => built.close(null));

  const submit = el("button", `btn ${options.tone === "danger" ? "danger" : "primary"}`,
    options.confirmLabel ?? "Save");
  submit.type = "button";
  submit.addEventListener("click", () => built.close(input.value));

  // Enter submits, as it would in a real form.
  input.addEventListener("keydown", event => {
    if (event.key === "Enter") {
      event.preventDefault();
      built.close(input.value);
    }
  });

  built.actions.append(cancel, submit);
  host().append(built.overlay);
  requestAnimationFrame(() => {
    input.focus();
    // select() throws InvalidStateError on the types that have no text
    // selection — date, time, number — so it is only for the ones that do.
    if (input.type === "text" || input.type === "search" || input.type === "tel") {
      input.select();
    }
  });

  return built.settle.then(value => (typeof value === "string" ? value : null));
}
