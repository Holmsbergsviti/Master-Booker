/* =====================================================================
   Small DOM helpers. Deliberately not a framework: these two pages are
   a handful of lists and a form each.
   ===================================================================== */

export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K, className?: string, text?: string
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

export function $<T extends HTMLElement = HTMLElement>(id: string): T {
  const node = document.getElementById(id);
  if (!node) throw new Error(`No element #${id}`);
  return node as T;
}

export function clear(node: HTMLElement): void {
  node.replaceChildren();
}

export function show(node: HTMLElement, visible: boolean): void {
  node.classList.toggle("hidden", !visible);
}

export function toast(message: string, kind: "info" | "error" | "success" = "info"): void {
  const host = document.getElementById("toastHost");
  if (!host) return;
  const node = el("div", `toast ${kind}`, message);
  host.append(node);
  setTimeout(() => {
    node.style.opacity = "0";
    node.style.transition = "opacity .25s";
    setTimeout(() => node.remove(), 260);
  }, kind === "error" ? 6000 : 3800);
}

/** Resolve the theme before the first paint elsewhere; this only wires
 *  the toggle up. */
export function wireTheme(button: HTMLElement): void {
  const apply = (theme: string) => {
    document.documentElement.setAttribute("data-theme", theme);
    button.textContent = theme === "dark" ? "☀" : "☾";
    try { localStorage.setItem("theme", theme); } catch { /* private mode */ }
  };
  apply(document.documentElement.getAttribute("data-theme") ?? "light");
  button.addEventListener("click", () => {
    apply(document.documentElement.getAttribute("data-theme") === "dark" ? "light" : "dark");
  });
}

/** A bar chart of monthly counts, drawn in CSS. */
export function barChart(
  host: HTMLElement,
  data: Array<{ key: string; count: number }>
): void {
  clear(host);
  if (data.length === 0) {
    host.append(el("p", "empty", "Nothing yet this season."));
    return;
  }
  const max = Math.max(...data.map(d => d.count), 1);
  const bars = el("div", "bars");
  const axis = el("div", "bar-axis");
  for (const point of data) {
    const bar = el("div", "bar");
    const fill = el("div", "fill");
    fill.style.height = `${Math.round((point.count / max) * 100)}%`;
    const cap = el("div", "cap", String(point.count));
    bar.append(fill, cap);
    bars.append(bar);
    axis.append(el("span", undefined, monthLabel(point.key)));
  }
  host.append(bars, axis);
}

function monthLabel(key: string): string {
  const month = Number(key.slice(5, 7));
  return ["", "Jan", "Feb", "Mar", "Apr", "May", "Jun",
          "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][month] ?? key;
}
