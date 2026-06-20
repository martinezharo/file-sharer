import { ChevronRight, Link2, Plus, ShieldCheck } from "lucide-preact";
import type { JSX } from "preact";
import { useEffect, useRef, useState } from "preact/hooks";
import { cancelLinking, createSpace, linking, startLinking } from "../actions";
import { renderQrToCanvas } from "../qr/generate";
import { showToast } from "../state/ui";
import { Button, Logo, Spinner } from "./components";

type Mode = "choose" | "create" | "link";

export function Onboarding(): JSX.Element {
  const [mode, setMode] = useState<Mode>("choose");
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);

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
    <div class="bg-grad grid min-h-full place-items-center p-6">
      <div class="w-full max-w-[420px] rounded-xl3 border border-line bg-surface p-9 shadow-float max-md:rounded-xl2 max-md:p-[22px]">
        <div class="mb-7 flex flex-col items-center gap-4 text-center">
          <Logo size="lg" />
          <div>
            <h1 class="text-2xl">file-sharer</h1>
            <p class="mx-auto mt-2 max-w-[300px] text-[14.5px] leading-relaxed text-muted">
              End-to-end encrypted text &amp; file sharing across your own devices.
            </p>
          </div>
          <span class="inline-flex items-center gap-1.5 rounded-full bg-accent-soft px-2.5 py-1.5 text-xs font-medium text-accent [&_svg]:size-3.5">
            <ShieldCheck />
            Zero-knowledge encryption
          </span>
        </div>

        {mode === "choose" && (
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
        )}

        {mode === "create" && (
          <form
            class="flex flex-col gap-4"
            onSubmit={(e) => {
              e.preventDefault();
              void onCreate();
            }}
          >
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
          <LinkFlow
            name={name}
            setName={setName}
            busy={busy}
            onStart={onStartLink}
            onBack={() => setMode("choose")}
          />
        )}
      </div>
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
      class="group flex w-full items-center gap-3.5 rounded-card border border-line-strong bg-surface px-4 py-[15px] text-left transition hover:border-accent hover:bg-surface-2 hover:shadow-pop active:translate-y-px"
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
        <p class="text-[13px] leading-relaxed text-muted">
          You&apos;ll get a code to scan from a device that is already in the space.
        </p>
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

  return (
    <div class="flex flex-col items-center gap-[18px] text-center">
      <p class="text-sm leading-relaxed text-subtle">
        On a device already in the space, open <strong class="text-ink">Devices → Add device</strong>{" "}
        and scan this code.
      </p>
      <div class="rounded-xl2 border border-line bg-white p-4 shadow-pop">
        <canvas ref={canvasRef} class="block rounded-lg" />
      </div>

      <details class="w-full">
        <summary class="cursor-pointer list-none p-1.5 text-center text-[13px] font-medium text-muted transition hover:text-ink [&::-webkit-details-marker]:hidden">
          Can&apos;t scan? Copy the code instead
        </summary>
        <textarea
          readOnly
          rows={4}
          class="field-input mt-2.5 break-all font-mono text-[12.5px] leading-relaxed text-subtle"
          value={link.qrText}
          onClick={(e) => (e.target as HTMLTextAreaElement).select()}
        />
      </details>

      {link.status === "error" ? (
        <p class="inline-flex items-center gap-2 rounded-full bg-danger-soft px-3.5 py-2 text-[13.5px] text-danger">
          Linking failed: {link.error}
        </p>
      ) : (
        <span class="inline-flex items-center gap-2.5 rounded-full bg-surface-3 px-3.5 py-2 text-[13.5px] text-subtle">
          <Spinner /> Waiting for the other device…
        </span>
      )}

      <Button variant="ghost" type="button" onClick={() => void cancelLinking()}>
        Cancel
      </Button>
    </div>
  );
}
