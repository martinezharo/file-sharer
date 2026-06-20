import type { DeviceInfo } from "@file-sharer/shared";
import { ClipboardPaste, Plus, ScanLine } from "lucide-preact";
import type { JSX } from "preact";
import { useEffect, useRef, useState } from "preact/hooks";
import { addDeviceFromQr, revokeDevice } from "../actions";
import { api } from "../api/client";
import { startScanner, type Scanner } from "../qr/scan";
import { authHeaders, session } from "../state/session";
import { showToast } from "../state/ui";
import { Button, cx, initials, Modal, Spinner } from "./components";

export function DeviceManager(): JSX.Element {
  const [devices, setDevices] = useState<DeviceInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [adding, setAdding] = useState(false);
  const myId = session.value?.deviceId;

  async function refresh(): Promise<void> {
    setLoading(true);
    try {
      const result = await api.listDevices(authHeaders());
      setDevices(result.devices);
    } catch (error) {
      showToast(error instanceof Error ? error.message : "Could not load devices", "error");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void refresh();
  }, []);

  async function onRevoke(device: DeviceInfo): Promise<void> {
    if (!confirm(`Revoke "${device.name}"? It will lose access to this space.`)) return;
    try {
      await revokeDevice(device.id);
      showToast(`Revoked ${device.name}`);
      await refresh();
    } catch (error) {
      showToast(error instanceof Error ? error.message : "Could not revoke device", "error");
    }
  }

  return (
    <div class="min-h-0 flex-1 overflow-y-auto p-6 max-md:p-[14px]">
      <div class="mx-auto flex max-w-[640px] flex-col gap-[18px]">
        <div class="flex items-center justify-between gap-3">
          <div>
            <div class="mb-1 font-mono text-[10px] font-medium uppercase tracking-[0.18em] text-accent">
              Workspace
            </div>
            <h2 class="text-[18px] font-semibold">Linked devices</h2>
            <p class="text-[12.5px] text-muted">Everyone with access to this encrypted space.</p>
          </div>
          <Button variant="primary" size="sm" onClick={() => setAdding(true)}>
            <Plus />
            Add device
          </Button>
        </div>

        {loading ? (
          <div class="grid place-items-center py-16">
            <Spinner large />
          </div>
        ) : (
          <div class="flex flex-col gap-2.5">
            {devices.map((device) => (
              <div
                key={device.id}
                class="flex items-center gap-3.5 rounded-card border border-line bg-surface px-[15px] py-[13px] shadow-soft transition hover:border-line-strong"
              >
                <div class="grid size-[42px] flex-none place-items-center rounded-xl bg-[linear-gradient(155deg,color-mix(in_srgb,var(--c-accent)_80%,#fff)_0%,var(--c-accent)_55%,color-mix(in_srgb,var(--c-accent)_72%,#000)_100%)] font-mono text-[14px] font-medium text-white ring-1 ring-inset ring-white/20">
                  {initials(device.name)}
                </div>
                <div class="min-w-0 flex-1">
                  <div class="flex items-center gap-2 text-[14.5px] font-medium">
                    <span class="truncate">{device.name}</span>
                    {device.id === myId && (
                      <span class="flex-none rounded-full bg-accent-soft px-2 py-0.5 font-mono text-[9.5px] font-medium uppercase tracking-[0.1em] text-accent">
                        This device
                      </span>
                    )}
                  </div>
                  <div class="font-mono text-[11.5px] text-muted">
                    Linked {new Date(device.createdAt).toLocaleString()}
                  </div>
                </div>
                {device.id !== myId && (
                  <Button variant="danger" size="sm" onClick={() => void onRevoke(device)}>
                    Revoke
                  </Button>
                )}
              </div>
            ))}
          </div>
        )}
      </div>

      {adding && (
        <AddDeviceModal
          onClose={() => setAdding(false)}
          onAdded={() => {
            setAdding(false);
            showToast("Device authorized. It should link shortly.");
            void refresh();
          }}
        />
      )}
    </div>
  );
}

function AddDeviceModal({
  onClose,
  onAdded,
}: {
  onClose: () => void;
  onAdded: () => void;
}): JSX.Element {
  const [tab, setTab] = useState<"scan" | "paste">("scan");
  const [pasted, setPasted] = useState("");
  const [busy, setBusy] = useState(false);
  const videoRef = useRef<HTMLVideoElement>(null);
  const scannerRef = useRef<Scanner | null>(null);
  const [cameraError, setCameraError] = useState<string | null>(null);

  async function submit(qrText: string): Promise<void> {
    setBusy(true);
    try {
      await addDeviceFromQr(qrText);
      onAdded();
    } catch (error) {
      showToast(error instanceof Error ? error.message : "Could not add device", "error");
      setBusy(false);
    }
  }

  useEffect(() => {
    if (tab !== "scan" || !videoRef.current) return;
    let active = true;
    void startScanner(
      videoRef.current,
      (text) => {
        if (!active) return;
        scannerRef.current?.stop();
        void submit(text);
      },
      (error) => setCameraError(error.message),
    ).then((scanner) => {
      scannerRef.current = scanner;
      if (!active) scanner.stop();
    });
    return () => {
      active = false;
      scannerRef.current?.stop();
      scannerRef.current = null;
    };
  }, [tab]);

  return (
    <Modal title="Add a device" onClose={onClose}>
      <div class="flex gap-[3px] rounded-card bg-surface-3 p-[3px]">
        <SegItem active={tab === "scan"} onClick={() => setTab("scan")}>
          <ScanLine />
          Scan QR
        </SegItem>
        <SegItem active={tab === "paste"} onClick={() => setTab("paste")}>
          <ClipboardPaste />
          Paste code
        </SegItem>
      </div>

      {tab === "scan" && (
        <div class="flex flex-col items-center gap-3">
          {cameraError ? (
            <p class="text-[13px] text-danger">{cameraError}. Use “Paste code” instead.</p>
          ) : (
            <video
              ref={videoRef}
              class="aspect-square w-full rounded-card border border-line bg-black object-cover"
              muted
              playsInline
            />
          )}
          {busy && (
            <p class="flex items-center gap-2 text-[13px] text-muted">
              <Spinner /> Authorizing…
            </p>
          )}
        </div>
      )}

      {tab === "paste" && (
        <form
          class="flex flex-col gap-3.5"
          onSubmit={(e) => {
            e.preventDefault();
            if (pasted.trim()) void submit(pasted.trim());
          }}
        >
          <textarea
            rows={5}
            class="field-input break-all font-mono text-[12.5px] leading-relaxed"
            placeholder="Paste the linking code from the new device"
            value={pasted}
            onInput={(e) => setPasted((e.target as HTMLTextAreaElement).value)}
          />
          <Button variant="primary" type="submit" disabled={busy || !pasted.trim()}>
            {busy ? <Spinner /> : "Authorize device"}
          </Button>
        </form>
      )}
    </Modal>
  );
}

function SegItem({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: preact.ComponentChildren;
}): JSX.Element {
  return (
    <button
      onClick={onClick}
      class={cx(
        "inline-flex flex-1 items-center justify-center gap-[7px] rounded-[10px] py-2 text-[13.5px] font-medium transition [&_svg]:size-4",
        active ? "bg-surface text-ink shadow-soft" : "text-muted hover:text-ink",
      )}
    >
      {children}
    </button>
  );
}
