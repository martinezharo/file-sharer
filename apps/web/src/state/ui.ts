import { signal } from "@preact/signals";

export type View = "chat" | "devices";

export const view = signal<View>("chat");

/** Text to push into the chat composer (e.g. from the Web Share Target). */
export const composerDraft = signal<string>("");

/** Connectivity hint shown in the header (best-effort). */
export const online = signal(navigator.onLine);

export interface Toast {
  id: number;
  message: string;
  kind: "info" | "error";
}

export const toasts = signal<Toast[]>([]);

let toastId = 0;

export function showToast(message: string, kind: Toast["kind"] = "info"): void {
  const toast: Toast = { id: ++toastId, message, kind };
  toasts.value = [...toasts.value, toast];
  setTimeout(() => {
    toasts.value = toasts.value.filter((t) => t.id !== toast.id);
  }, 4000);
}

if (typeof window !== "undefined") {
  window.addEventListener("online", () => (online.value = true));
  window.addEventListener("offline", () => (online.value = false));
}
