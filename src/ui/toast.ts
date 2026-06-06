// A tiny, dependency-free toast system. Toasts stack at the bottom-center of the
// viewport, auto-dismiss after a delay, and can be tapped to dismiss early. The
// container is a single aria-live region so screen readers announce new messages.

export type ToastVariant = "success" | "info" | "error";

interface ToastOptions {
  variant?: ToastVariant;
  /** Auto-dismiss delay in ms. */
  duration?: number;
}

let container: HTMLElement | null = null;

function ensureContainer(): HTMLElement {
  if (container) return container;
  const el = document.createElement("div");
  el.className = "toast-root";
  el.setAttribute("role", "status");
  el.setAttribute("aria-live", "polite");
  document.body.appendChild(el);
  container = el;
  return el;
}

export function showToast(message: string, opts: ToastOptions = {}): void {
  const { variant = "info", duration = 4500 } = opts;
  const root = ensureContainer();

  const toast = document.createElement("div");
  toast.className = `toast toast-${variant}`;
  toast.textContent = message; // textContent, not innerHTML — message may hold a filename
  root.appendChild(toast);

  // Add the visible class on the next frame so the entrance transition runs,
  // rather than the toast appearing already settled in place.
  requestAnimationFrame(() => toast.classList.add("is-visible"));

  let dismissed = false;
  const dismiss = () => {
    if (dismissed) return;
    dismissed = true;
    toast.classList.remove("is-visible");
    const remove = () => toast.remove();
    toast.addEventListener("transitionend", remove, { once: true });
    setTimeout(remove, 300); // fallback when the transition is suppressed (reduced motion)
  };

  const timer = window.setTimeout(dismiss, duration);
  toast.addEventListener("click", () => {
    window.clearTimeout(timer);
    dismiss();
  });
}
