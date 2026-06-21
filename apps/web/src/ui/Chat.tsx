import {
  AlertCircle,
  ArrowUp,
  CheckCheck,
  Clock,
  Download,
  FileText,
  Lock,
  Plus,
  RotateCw,
} from "lucide-preact";
import type { JSX } from "preact";
import { useEffect, useRef, useState } from "preact/hooks";
import { listDevicesDecrypted, saveFile, sendFileMessages, sendTextMessage } from "../actions";
import { messages } from "../state/messages";
import { session } from "../state/session";
import { composerDraft } from "../state/ui";
import { syncNow } from "../sync/sync";
import type { LocalMessage } from "../types";
import { cx, formatBytes, formatTime, IconButton, Spinner } from "./components";

const URL_RE = /https?:\/\/[^\s<>"')\]]+/gi;

function Linkify({ text }: { text: string }): JSX.Element {
  const parts: (string | JSX.Element)[] = [];
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  URL_RE.lastIndex = 0;
  while ((match = URL_RE.exec(text)) !== null) {
    if (match.index > lastIndex) {
      parts.push(text.slice(lastIndex, match.index));
    }
    const url = match[0];
    parts.push(
      <a
        href={url}
        target="_blank"
        rel="noopener noreferrer"
        class="underline underline-offset-2 decoration-current opacity-80 hover:opacity-100"
      >
        {url}
      </a>,
    );
    lastIndex = match.index + url.length;
  }
  if (lastIndex < text.length) {
    parts.push(text.slice(lastIndex));
  }
  return <>{parts}</>;
}

export function Chat(): JSX.Element {
  const list = messages.value;
  const currentSession = session.value;
  const myId = currentSession?.deviceId;
  const [deviceNames, setDeviceNames] = useState<Map<string, string>>(() => new Map());
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [list.length]);

  useEffect(() => {
    if (!currentSession) return;

    let cancelled = false;
    listDevicesDecrypted()
      .then((devices) => {
        if (!cancelled) {
          setDeviceNames(new Map(devices.map((device) => [device.id, device.name])));
        }
      })
      .catch(() => {
        /* Names for newly received messages still come from /messages/pending. */
      });

    return () => {
      cancelled = true;
    };
  }, [currentSession?.groupId, currentSession?.deviceId]);

  return (
    <div class="flex min-h-0 flex-1 flex-col">
      <div class="flex-1 overflow-y-auto px-6 pb-2 pt-[22px] max-md:px-[14px] max-md:pt-4">
        <div class="mx-auto flex w-full max-w-[760px] flex-col gap-[3px]">
          {list.length === 0 && <EmptyState />}
          {list.map((message) => (
            <MessageBubble
              key={message.id}
              message={message}
              mine={message.senderDeviceId === myId}
              deviceName={deviceNames.get(message.senderDeviceId)}
            />
          ))}
          <div ref={bottomRef} />
        </div>
      </div>
      <Composer />
    </div>
  );
}

function EmptyState(): JSX.Element {
  return (
    <div class="m-auto flex max-w-[360px] flex-col items-center gap-3.5 px-5 py-10 text-center">
      <div class="grid size-14 place-items-center rounded-xl2 bg-surface text-accent shadow-pop dark:bg-surface-2 [&_svg]:size-[26px]">
        <Lock />
      </div>
      <div class="font-mono text-[10px] font-medium uppercase tracking-[0.2em] text-accent">
        End-to-end encrypted
      </div>
      <h3 class="-mt-1.5 text-[19px]">Your private channel</h3>
      <p class="text-sm leading-relaxed text-muted">
        Messages and files you send are encrypted on this device and synced only across your own
        linked devices.
      </p>
    </div>
  );
}

function MessageBubble({
  message,
  mine,
  deviceName,
}: {
  message: LocalMessage;
  mine: boolean;
  deviceName?: string;
}): JSX.Element {
  const displayDeviceName =
    message.senderDeviceName ?? deviceName ?? (mine ? session.value?.deviceName : undefined);

  return (
    <div class={cx("mt-[9px] flex", mine ? "justify-end" : "justify-start")}>
      <div
        class={cx(
          "max-w-[min(80%,540px)] rounded-card text-[14.5px] leading-normal shadow-soft max-md:max-w-[86%]",
          message.file ? "p-[7px]" : "px-[13px] py-[9px]",
          mine
            ? "rounded-br-[5px] bg-accent text-on-accent"
            : "rounded-bl-[5px] bg-surface text-ink dark:bg-surface-2",
        )}
      >
        {displayDeviceName && (
          <div
            class={cx(
              "mb-1 max-w-full truncate text-[11px] font-medium leading-tight",
              mine ? "text-on-accent/75" : "text-subtle",
            )}
            title={displayDeviceName}
          >
            {displayDeviceName}
          </div>
        )}
        {message.text && <div class="whitespace-pre-wrap break-words"><Linkify text={message.text} /></div>}
        {message.file && <FileAttachment message={message} mine={mine} />}
        <div
          class={cx(
            "mt-1 flex items-center justify-end gap-[5px] font-mono text-[10px] tracking-[0.03em] [&_svg]:size-[14px]",
            mine ? "text-on-accent/70" : "text-muted",
          )}
        >
          <span>{formatTime(message.createdAt)}</span>
          {mine && message.status === "queued" && <Clock />}
          {mine && message.status === "sent" && <CheckCheck />}
          {mine && message.status === "failed" && (
            <AlertCircle class="!opacity-100" aria-label="Failed to send" />
          )}
        </div>
      </div>
    </div>
  );
}

function FileAttachment({ message, mine }: { message: LocalMessage; mine: boolean }): JSX.Element {
  const file = message.file!;
  const state = message.fileState;

  return (
    <div
      class={cx(
        "flex min-w-[240px] items-center gap-[11px] rounded-[10px] px-2.5 py-2",
        mine ? "bg-black/15" : "bg-surface-3",
      )}
    >
      <div
        class={cx(
          "grid size-10 flex-none place-items-center rounded-[10px] text-accent [&_svg]:size-5",
          mine ? "bg-white/90" : "bg-surface",
        )}
      >
        <FileText />
      </div>
      <div class="min-w-0 flex-1">
        <div class="truncate text-[13.5px] font-medium" title={file.name}>
          {file.name}
        </div>
        <div class={cx("font-mono text-[11px] tracking-[0.02em]", mine ? "text-on-accent/70" : "text-muted")}>
          {formatBytes(file.size)}
        </div>
      </div>
      <div class="flex-none">
        {state === "downloading" && <Spinner />}
        {(state === "downloaded" || message.direction === "out") && (
          <IconButton
            label="Save file"
            class={cx("size-[34px]", mine && "text-white/90 hover:bg-white/15 hover:text-white")}
            onClick={() => void saveFile(message)}
          >
            <Download />
          </IconButton>
        )}
        {state === "error" && (
          <IconButton
            label="Retry download"
            class={cx("size-[34px]", mine && "text-white/90 hover:bg-white/15 hover:text-white")}
            onClick={() => void syncNow()}
          >
            <RotateCw />
          </IconButton>
        )}
      </div>
    </div>
  );
}

function Composer(): JSX.Element {
  const [text, setText] = useState("");
  const fileRef = useRef<HTMLInputElement>(null);
  const taRef = useRef<HTMLTextAreaElement>(null);

  function autosize(): void {
    const ta = taRef.current;
    if (!ta) return;
    ta.style.height = "auto";
    ta.style.height = `${Math.min(ta.scrollHeight, 140)}px`;
  }

  // Pull in shared text (Web Share Target). `subscribe` also fires with the
  // current value on mount, covering shares that arrive before this renders.
  useEffect(
    () =>
      composerDraft.subscribe((draft) => {
        if (!draft) return;
        composerDraft.value = "";
        setText((prev) => (prev ? `${prev}\n${draft}` : draft));
        requestAnimationFrame(() => {
          autosize();
          taRef.current?.focus();
        });
      }),
    [],
  );

  function submit(): void {
    const value = text.trim();
    if (!value) return;
    setText("");
    requestAnimationFrame(autosize);
    void sendTextMessage(value);
  }

  function onPickFile(event: Event): void {
    const input = event.target as HTMLInputElement;
    const files = Array.from(input.files ?? []);
    if (files.length > 0) void sendFileMessages(files);
    input.value = "";
  }

  const canSend = !!text.trim();

  return (
    <div class="flex-none px-6 pb-[calc(16px+env(safe-area-inset-bottom))] pt-2 max-md:px-[14px] max-md:pb-[calc(14px+env(safe-area-inset-bottom))]">
      <div class="mx-auto flex max-w-[760px] items-end gap-1.5 rounded-[24px] bg-surface px-2 py-2 shadow-pop dark:bg-surface-2">
        <input ref={fileRef} type="file" multiple hidden onChange={onPickFile} />
        <button
          type="button"
          aria-label="Attach file"
          title="Attach file"
          onClick={() => fileRef.current?.click()}
          class="grid size-9 flex-none place-items-center rounded-full text-subtle transition hover:bg-surface-3 hover:text-ink active:scale-90 [&_svg]:size-[21px]"
        >
          <Plus strokeWidth={2.25} />
        </button>
        <textarea
          ref={taRef}
          class="no-scrollbar max-h-[160px] flex-1 self-center border-none bg-transparent px-1.5 py-[7px] text-[15px] leading-[1.45] text-ink outline-none placeholder:text-muted focus:!shadow-none focus-visible:!shadow-none"
          placeholder="Write a message"
          value={text}
          rows={1}
          onInput={(e) => {
            setText((e.target as HTMLTextAreaElement).value);
            autosize();
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              submit();
            }
          }}
        />
        <button
          type="button"
          aria-label="Send message"
          title="Send"
          onClick={submit}
          disabled={!canSend}
          class="grid size-9 flex-none place-items-center rounded-full bg-accent text-on-accent transition hover:bg-accent-hover active:scale-90 disabled:cursor-not-allowed disabled:bg-surface-3 disabled:text-muted [&_svg]:size-[18px]"
        >
          <ArrowUp strokeWidth={2.5} />
        </button>
      </div>
    </div>
  );
}
