import type { ComponentChildren, JSX } from "preact";
import { AlertCircle, CheckCircle2, Shield, X } from "lucide-preact";
import { toasts } from "../state/ui";

/** Tiny className joiner. */
export function cx(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(" ");
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value.toFixed(value < 10 ? 1 : 0)} ${units[unit]}`;
}

export function formatTime(ts: number): string {
  return new Date(ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

export function initials(name: string): string {
  const parts = name.trim().split(/\s+/);
  const first = parts[0]?.[0] ?? "?";
  const second = parts.length > 1 ? (parts[parts.length - 1]?.[0] ?? "") : "";
  return (first + second).toUpperCase();
}

/* --------------------------------------------------------------------------
   Button
   ------------------------------------------------------------------------ */
type ButtonVariant = "primary" | "secondary" | "ghost" | "danger";

const BUTTON_BASE =
  "inline-flex items-center justify-center gap-2 rounded-card font-medium tracking-[-0.01em] whitespace-nowrap transition active:scale-[0.995] disabled:opacity-50 disabled:cursor-not-allowed [&_svg]:size-[18px]";

const BUTTON_VARIANTS: Record<ButtonVariant, string> = {
  primary:
    "bg-accent text-on-accent shadow-accent hover:bg-accent-hover active:bg-accent-press",
  secondary: "bg-surface border border-line-strong text-ink hover:bg-surface-3",
  ghost: "bg-transparent text-subtle hover:bg-surface-3 hover:text-ink",
  danger:
    "bg-transparent text-danger border border-danger/35 hover:bg-danger-soft",
};

interface ButtonProps extends Omit<JSX.IntrinsicElements["button"], "size"> {
  variant?: ButtonVariant;
  size?: "md" | "sm";
}

export function Button({
  variant = "secondary",
  size = "md",
  class: cls,
  children,
  ...rest
}: ButtonProps): JSX.Element {
  return (
    <button
      {...rest}
      class={cx(
        BUTTON_BASE,
        BUTTON_VARIANTS[variant],
        size === "sm"
          ? "h-[34px] w-auto px-3 text-[13px] rounded-[10px]"
          : "h-[42px] w-full px-4 text-[14.5px]",
        cls as string,
      )}
    >
      {children}
    </button>
  );
}

/* --------------------------------------------------------------------------
   Icon button
   ------------------------------------------------------------------------ */
type IconButtonProps = JSX.IntrinsicElements["button"] & { label: string };

export function IconButton({ label, class: cls, children, ...rest }: IconButtonProps): JSX.Element {
  return (
    <button
      {...rest}
      aria-label={label}
      title={label}
      class={cx(
        "inline-flex items-center justify-center size-[38px] rounded-[10px] text-subtle transition hover:bg-surface-3 hover:text-ink active:scale-90 disabled:opacity-40 disabled:cursor-not-allowed [&_svg]:size-[19px]",
        cls as string,
      )}
    >
      {children}
    </button>
  );
}

/* --------------------------------------------------------------------------
   Brand logo
   ------------------------------------------------------------------------ */
export function Logo({ size = "md" }: { size?: "md" | "lg" }): JSX.Element {
  const lg = size === "lg";
  return (
    <span class="inline-flex items-center gap-2.5 text-ink">
      <span
        class={cx(
          "grid place-items-center text-white shadow-accent flex-none ring-1 ring-inset ring-white/20",
          "bg-[linear-gradient(155deg,color-mix(in_srgb,var(--c-accent)_82%,#fff)_0%,var(--c-accent)_52%,color-mix(in_srgb,var(--c-accent)_72%,#000)_100%)]",
          lg ? "size-14 rounded-[18px] [&_svg]:size-[30px]" : "size-[34px] rounded-[11px] [&_svg]:size-[19px]",
        )}
      >
        <Shield strokeWidth={2.25} fill="currentColor" stroke="none" />
      </span>
      {!lg && (
        <span class="font-mono text-[12.5px] font-medium uppercase tracking-[0.16em] text-ink">
          file<span class="text-accent">·</span>sharer
        </span>
      )}
    </span>
  );
}

/* --------------------------------------------------------------------------
   Spinner
   ------------------------------------------------------------------------ */
export function Spinner({ large = false }: { large?: boolean }): JSX.Element {
  return (
    <span
      class={cx("spinner", large && "!size-[26px] !border-[2.5px]")}
      aria-label="loading"
    />
  );
}

/* --------------------------------------------------------------------------
   Toasts
   ------------------------------------------------------------------------ */
export function Toasts(): JSX.Element {
  return (
    <div
      class="fixed left-1/2 top-[calc(16px+env(safe-area-inset-top))] z-[100] flex w-max max-w-[min(92vw,420px)] -translate-x-1/2 flex-col items-center gap-2.5 max-md:top-[calc(68px+env(safe-area-inset-top))]"
      role="status"
      aria-live="polite"
    >
      {toasts.value.map((t) => (
        <div
          key={t.id}
          class={cx(
            "animate-toast-in flex items-center gap-2.5 rounded-card border border-line bg-elevated px-3.5 py-3 text-[13.5px] font-medium text-ink shadow-float [&_svg]:size-[18px] [&_svg]:flex-none",
            t.kind === "error" && "border-danger/40",
          )}
        >
          {t.kind === "error" ? (
            <AlertCircle class="text-danger" />
          ) : (
            <CheckCircle2 class="text-accent" />
          )}
          <span>{t.message}</span>
        </div>
      ))}
    </div>
  );
}

/* --------------------------------------------------------------------------
   Modal
   ------------------------------------------------------------------------ */
interface ModalProps {
  title: string;
  onClose: () => void;
  children: ComponentChildren;
}

export function Modal({ title, onClose, children }: ModalProps): JSX.Element {
  return (
    <div
      class="animate-fade-in fixed inset-0 z-50 flex items-center justify-center bg-[color-mix(in_srgb,#0a0a0c_55%,transparent)] p-4 backdrop-blur-[4px]"
      onClick={onClose}
    >
      <div
        class="animate-modal-in w-full max-w-[440px] overflow-hidden rounded-xl3 bg-elevated shadow-float"
        onClick={(e) => e.stopPropagation()}
      >
        <header class="flex items-center justify-between py-4 pl-[22px] pr-[18px]">
          <h2 class="text-[17px] font-semibold">{title}</h2>
          <IconButton label="Close" onClick={onClose}>
            <X />
          </IconButton>
        </header>
        <div class="flex flex-col gap-4 px-[22px] pb-[22px] pt-1">{children}</div>
      </div>
    </div>
  );
}
