import { LogOut, MessagesSquare, MonitorSmartphone } from "lucide-preact";
import type { JSX } from "preact";
import { logout } from "../actions";
import { ready, session } from "../state/session";
import { online, view, type View } from "../state/ui";
import { Chat } from "./Chat";
import { cx, IconButton, Logo, Spinner, Toasts } from "./components";
import { DeviceManager } from "./DeviceManager";
import { Onboarding } from "./Onboarding";

const NAV: Array<{ id: View; label: string; icon: typeof MessagesSquare }> = [
  { id: "chat", label: "Messages", icon: MessagesSquare },
  { id: "devices", label: "Devices", icon: MonitorSmartphone },
];

export function App(): JSX.Element {
  if (!ready.value) {
    return (
      <div class="bg-grad grid h-full place-items-center">
        <Spinner large />
      </div>
    );
  }

  if (!session.value) {
    return (
      <>
        <Onboarding />
        <Toasts />
      </>
    );
  }

  const current = view.value;
  const meta = current === "chat" ? "Messages" : "Devices";

  return (
    <div class="bg-grad flex h-full">
      {/* Desktop sidebar */}
      <aside class="hidden w-[248px] flex-none flex-col gap-1 border-r border-line bg-[color-mix(in_srgb,var(--c-surface)_55%,transparent)] p-[14px] pt-[18px] backdrop-blur-xl md:flex">
        <div class="px-2 pb-4 pt-1.5">
          <Logo />
        </div>

        <nav class="flex flex-col gap-[3px]">
          {NAV.map(({ id, label, icon: Icon }) => (
            <NavItem key={id} active={current === id} onClick={() => (view.value = id)}>
              <Icon />
              {label}
            </NavItem>
          ))}
        </nav>

        <div class="mt-auto flex flex-col gap-[3px]">
          <div class="flex items-center gap-2 px-[11px] py-2 text-[12.5px] font-medium text-muted">
            <span
              class={cx(
                "size-2 flex-none rounded-full",
                online.value
                  ? "bg-success shadow-[0_0_0_3px_color-mix(in_srgb,var(--c-success)_22%,transparent)]"
                  : "bg-muted",
              )}
            />
            {online.value ? "Connected" : "Offline"}
          </div>
          <NavItem danger onClick={() => void logout()}>
            <LogOut />
            Leave space
          </NavItem>
        </div>
      </aside>

      <div class="flex min-h-0 min-w-0 flex-1 flex-col">
        {/* Mobile top bar */}
        <header class="sticky top-0 z-20 flex h-[calc(56px+env(safe-area-inset-top))] flex-none items-center justify-between gap-3 border-b border-line bg-[color-mix(in_srgb,var(--c-surface)_80%,transparent)] px-[14px] pt-[env(safe-area-inset-top)] backdrop-blur-xl md:hidden">
          <Logo />
          <div class="flex items-center gap-0.5">
            <div class="flex gap-0.5 rounded-[10px] bg-surface-3 p-[3px]">
              {NAV.map(({ id, label, icon: Icon }) => (
                <button
                  key={id}
                  aria-label={label}
                  onClick={() => (view.value = id)}
                  class={cx(
                    "inline-flex h-8 w-[38px] items-center justify-center rounded-[7px] transition [&_svg]:size-[18px]",
                    current === id
                      ? "bg-surface text-accent shadow-soft"
                      : "text-muted",
                  )}
                >
                  <Icon />
                </button>
              ))}
            </div>
            <IconButton label="Leave space" onClick={() => void logout()}>
              <LogOut />
            </IconButton>
          </div>
        </header>

        {/* Desktop view header */}
        <div class="hidden h-[60px] flex-none items-center justify-between gap-3 border-b border-line px-6 md:flex">
          <div>
            <div class="text-base font-semibold tracking-[-0.02em]">{meta}</div>
          </div>
        </div>

        <main class="flex min-h-0 flex-1 flex-col">
          {current === "chat" ? <Chat /> : <DeviceManager />}
        </main>
      </div>

      <Toasts />
    </div>
  );
}

function NavItem({
  active,
  danger,
  onClick,
  children,
}: {
  active?: boolean;
  danger?: boolean;
  onClick: () => void;
  children: preact.ComponentChildren;
}): JSX.Element {
  return (
    <button
      onClick={onClick}
      class={cx(
        "flex w-full items-center gap-[11px] rounded-[10px] px-[11px] py-[9px] text-left text-[14px] font-medium transition [&_svg]:size-[18px] [&_svg]:flex-none [&_svg]:opacity-85",
        active
          ? "bg-accent-soft text-accent [&_svg]:opacity-100"
          : danger
            ? "text-subtle hover:bg-danger-soft hover:text-danger"
            : "text-subtle hover:bg-surface-3 hover:text-ink",
      )}
    >
      {children}
    </button>
  );
}
