import { Check, ChevronRight, Copy, Link2, Plus, ShieldCheck } from "lucide-preact";
import type { JSX } from "preact";
import { useEffect, useRef, useState } from "preact/hooks";
import { cancelLinking, createSpace, linking, startLinking } from "../actions";
import { renderQrToCanvas } from "../qr/generate";
import { showToast } from "../state/ui";
import { Button, Spinner } from "./components";

type Mode = "choose" | "create" | "link";

/**
 * The sign-up / device-linking panel. Used as the primary call-to-action on
 * the landing page (the create / link buttons stay visible above the fold).
 */
export function OnboardingCard(): JSX.Element {
  const [mode, setMode] = useState<Mode>("choose");
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const link = linking.value;

  async function onCreate(): Promise<void> {
    if (!name.trim()) return;
    setBusy(true);
    try {
      await createSpace(name.trim());
    } catch (error) {
      showToast(error instanceof Error ? error.message : "Could not create space", "error");
    } finally {
      setBusy(false);
    }
  }

  async function onStartLink(): Promise<void> {
    if (!name.trim()) return;
    setBusy(true);
    try {
      await startLinking(name.trim());
    } catch (error) {
      showToast(error instanceof Error ? error.message : "Could not start linking", "error");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div
      id="get-started"
      class="w-full scroll-mt-24 rounded-xl3 bg-surface p-7 shadow-float max-md:rounded-xl2 max-md:p-6"
    >
      {mode === "choose" && (
        <>
          <header class="mb-6">
            <span class="inline-flex items-center gap-1.5 rounded-full bg-accent-soft px-3 py-1.5 font-mono text-[10px] font-medium uppercase tracking-[0.14em] text-accent [&_svg]:size-3.5">
              <ShieldCheck />
              Zero-knowledge
            </span>
            <h2 class="mt-3.5 text-[22px] tracking-[-0.02em]">Start sharing privately</h2>
            <p class="mt-1.5 text-sm leading-relaxed text-muted">
              Create a private space or link this device to one you already have. Free, no account
              needed.
            </p>
          </header>
          <div class="flex flex-col gap-2.5">
            <Choice
              icon={<Plus />}
              title="Create a new space"
              desc="Start fresh on this device"
              onClick={() => setMode("create")}
            />
            <Choice
              icon={<Link2 />}
              title="Link to an existing space"
              desc="Join from another device"
              onClick={() => setMode("link")}
            />
          </div>
        </>
      )}

      {mode === "create" && (
        <form
          class="flex flex-col gap-4"
          onSubmit={(e) => {
            e.preventDefault();
            void onCreate();
          }}
        >
          <header class="mb-1">
            <h2 class="text-[22px] tracking-[-0.02em]">Create a space</h2>
            <p class="mt-1.5 text-sm leading-relaxed text-muted">
              Give this device a name to get started.
            </p>
          </header>
          <DeviceNameField value={name} onInput={setName} placeholder="e.g. My laptop" />
          <div class="mt-1 flex flex-col gap-2">
            <Button variant="primary" type="submit" disabled={busy || !name.trim()}>
              {busy ? <Spinner /> : "Create space"}
            </Button>
            <Button variant="ghost" type="button" onClick={() => setMode("choose")}>
              Back
            </Button>
          </div>
        </form>
      )}

      {mode === "link" && (
        <>
          {!link && (
            <header class="mb-4">
              <h2 class="text-[22px] tracking-[-0.02em]">Link this device</h2>
              <p class="mt-1.5 text-sm leading-relaxed text-muted">
                Name this device, then scan the code from one already in the space.
              </p>
            </header>
          )}
          <LinkFlow
            name={name}
            setName={setName}
            busy={busy}
            onStart={onStartLink}
            onBack={() => setMode("choose")}
          />
        </>
      )}
    </div>
  );
}

function Choice({
  icon,
  title,
  desc,
  onClick,
}: {
  icon: JSX.Element;
  title: string;
  desc: string;
  onClick: () => void;
}): JSX.Element {
  return (
    <button
      onClick={onClick}
      class="group flex w-full items-center gap-3.5 rounded-card bg-surface-3 px-4 py-[15px] text-left transition hover:shadow-pop hover:ring-1 hover:ring-inset hover:ring-accent/40 active:translate-y-px"
    >
      <span class="grid size-[42px] flex-none place-items-center rounded-[10px] bg-accent-soft text-accent [&_svg]:size-[21px]">
        {icon}
      </span>
      <span class="min-w-0 flex-1">
        <span class="block text-[14.5px] font-semibold">{title}</span>
        <span class="block text-[12.5px] text-muted">{desc}</span>
      </span>
      <ChevronRight class="size-[18px] flex-none text-muted transition group-hover:translate-x-0.5 group-hover:text-accent" />
    </button>
  );
}

function DeviceNameField({
  value,
  onInput,
  placeholder,
}: {
  value: string;
  onInput: (v: string) => void;
  placeholder: string;
}): JSX.Element {
  return (
    <label class="flex flex-col gap-1.5 text-left">
      <span class="text-[13px] font-medium text-subtle">Name this device</span>
      <input
        type="text"
        class="field-input"
        value={value}
        placeholder={placeholder}
        maxLength={64}
        autoFocus
        onInput={(e) => onInput((e.target as HTMLInputElement).value)}
      />
    </label>
  );
}

interface LinkFlowProps {
  name: string;
  setName: (value: string) => void;
  busy: boolean;
  onStart: () => void;
  onBack: () => void;
}

function LinkFlow({ name, setName, busy, onStart, onBack }: LinkFlowProps): JSX.Element {
  const link = linking.value;
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (link && canvasRef.current) {
      void renderQrToCanvas(canvasRef.current, link.qrText);
    }
  }, [link?.qrText]);

  if (!link) {
    return (
      <form
        class="flex flex-col gap-4"
        onSubmit={(e) => {
          e.preventDefault();
          onStart();
        }}
      >
        <DeviceNameField value={name} onInput={setName} placeholder="e.g. My phone" />
        <div class="mt-1 flex flex-col gap-2">
          <Button variant="primary" type="submit" disabled={busy || !name.trim()}>
            {busy ? <Spinner /> : "Generate linking code"}
          </Button>
          <Button variant="ghost" type="button" onClick={onBack}>
            Back
          </Button>
        </div>
      </form>
    );
  }

  const qrText = link.qrText;

  async function copyCode(): Promise<void> {
    try {
      await navigator.clipboard.writeText(qrText);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      showToast("Couldn't copy to clipboard", "error");
    }
  }

  return (
    <div class="flex flex-col items-center gap-5 text-center">
      <p class="text-sm leading-relaxed text-subtle">
        On a device already in the space, open <strong class="text-ink">Devices → Add device</strong>{" "}
        and scan this code.
      </p>
      <div class="rounded-xl2 bg-white p-4 shadow-pop">
        <canvas ref={canvasRef} class="block rounded-lg" />
      </div>

      {link.status === "error" ? (
        <p class="inline-flex items-center gap-2 rounded-full bg-danger-soft px-3.5 py-2 text-[13.5px] text-danger">
          Linking failed: {link.error}
        </p>
      ) : (
        <span class="inline-flex items-center gap-2.5 rounded-full bg-surface-3 px-3.5 py-2 font-mono text-[10.5px] font-medium uppercase tracking-[0.14em] text-subtle">
          <Spinner /> Waiting for device
        </span>
      )}

      <div class="flex w-full flex-col gap-2">
        <Button variant="secondary" type="button" onClick={() => void copyCode()}>
          {copied ? (
            <>
              <Check /> Code copied
            </>
          ) : (
            <>
              <Copy /> Can&apos;t scan? Copy code
            </>
          )}
        </Button>
        <Button variant="ghost" type="button" onClick={() => void cancelLinking()}>
          Cancel
        </Button>
      </div>
    </div>
  );
}
