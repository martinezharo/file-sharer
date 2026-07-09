import {
  AlertCircle,
  ArrowUp,
  CheckCheck,
  Clock,
  Download,
  File as FileIcon,
  FileArchive,
  FileAudio,
  FileCode,
  FileImage,
  FileSpreadsheet,
  FileText,
  FileVideo,
  Lock,
  MoreVertical,
  Plus,
  RotateCw,
} from "lucide-preact";
import type { JSX } from "preact";
import { useEffect, useRef, useState } from "preact/hooks";
import {
  listDevicesDecrypted,
  retryMessage,
  saveFile,
  sendFileMessages,
  sendTextMessage,
} from "../actions";
import { getFile } from "../db/store";
import { messages } from "../state/messages";
import { session } from "../state/session";
import { composerDraft } from "../state/ui";
import { syncNow } from "../sync/sync";
import type { FileRef, LocalMessage } from "../types";
import { cx, formatBytes, formatTime, IconButton, Spinner } from "./components";
import { type MenuAnchor, MessageMenu } from "./MessageMenu";

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

/** Incoming file messages whose blob hasn't been fetched from the server yet. */
function countIncomingDownloads(list: LocalMessage[]): number {
  return list.filter(
    (m) =>
      m.direction === "in" &&
      m.file &&
      (m.fileState === "remote" || m.fileState === "downloading"),
  ).length;
}

export function Chat(): JSX.Element {
  const list = messages.value;
  const downloading = countIncomingDownloads(list);
  const currentSession = session.value;
  const myId = currentSession?.deviceId;
  const [deviceNames, setDeviceNames] = useState<Map<string, string>>(() => new Map());
  const bottomRef = useRef<HTMLDivElement>(null);
  const hasScrolledRef = useRef(false);

  useEffect(() => {
    // Open the chat already at the bottom; only animate for messages that
    // arrive afterwards. The list starts empty and fills in async from
    // IndexedDB, so "opened" means the first render that had messages.
    bottomRef.current?.scrollIntoView({ behavior: hasScrolledRef.current ? "smooth" : "auto" });
    if (list.length > 0) hasScrolledRef.current = true;
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
    <div class="relative flex min-h-0 flex-1 flex-col">
      {downloading > 0 && (
        <div class="pointer-events-none absolute left-1/2 top-3 z-10 -translate-x-1/2">
          <div
            role="status"
            class="flex items-center gap-2 rounded-full bg-elevated px-3.5 py-[7px] text-[12.5px] font-medium text-ink shadow-pop"
          >
            <Spinner class="!size-[13px] !border-[1.5px]" />
            <span>
              Receiving {downloading === 1 ? "1 file" : `${downloading} files`}…
            </span>
          </div>
        </div>
      )}
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

/** How long a touch must be held on a bubble before the menu opens. */
const LONG_PRESS_MS = 400;
/** Finger drift beyond this cancels the long-press (it's a scroll). */
const LONG_PRESS_DRIFT_PX = 10;

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

  const [menu, setMenu] = useState<MenuAnchor | null>(null);
  const pressTimer = useRef<number | null>(null);
  const pressStart = useRef<{ pointerId: number; x: number; y: number } | null>(null);
  const suppressTouchEnd = useRef(false);

  function cancelPress(): void {
    if (pressTimer.current !== null) clearTimeout(pressTimer.current);
    pressTimer.current = null;
    pressStart.current = null;
  }

  // iOS Safari never fires `contextmenu` on long-press, so touch long-press is
  // detected by hand. Android's native long-press arrives as `contextmenu`
  // (handled below), racing this timer — whichever fires first wins.
  function onPointerDown(e: JSX.TargetedPointerEvent<HTMLDivElement>): void {
    if (e.pointerType !== "touch" || menu) return;
    // A second finger means a scroll/zoom gesture, not a long-press.
    if (pressStart.current) {
      cancelPress();
      return;
    }
    suppressTouchEnd.current = false;
    const { pointerId, clientX, clientY } = e;
    pressStart.current = { pointerId, x: clientX, y: clientY };
    pressTimer.current = window.setTimeout(() => {
      cancelPress();
      suppressTouchEnd.current = true;
      navigator.vibrate?.(10);
      setMenu({ x: clientX, y: clientY });
    }, LONG_PRESS_MS);
  }

  // The menu opens while the finger is still down. Lifting it would otherwise
  // synthesize a click on whatever now sits at that point — the menu backdrop
  // (closing it instantly) or even the first menu item — so swallow it.
  function onTouchEnd(e: JSX.TargetedTouchEvent<HTMLDivElement>): void {
    if (!suppressTouchEnd.current) return;
    suppressTouchEnd.current = false;
    e.preventDefault();
  }

  function onPointerMove(e: JSX.TargetedPointerEvent<HTMLDivElement>): void {
    const start = pressStart.current;
    if (!start || e.pointerId !== start.pointerId) return;
    if (Math.hypot(e.clientX - start.x, e.clientY - start.y) > LONG_PRESS_DRIFT_PX) cancelPress();
  }

  // Desktop right-click and Android long-press.
  function onContextMenu(e: JSX.TargetedMouseEvent<HTMLDivElement>): void {
    e.preventDefault();
    cancelPress();
    if (!menu) setMenu({ x: e.clientX, y: e.clientY });
  }

  function openFromTrigger(e: JSX.TargetedMouseEvent<HTMLButtonElement>): void {
    const rect = e.currentTarget.getBoundingClientRect();
    setMenu({ x: mine ? rect.right : rect.left, y: rect.bottom + 6 });
  }

  return (
    <div class={cx("group mt-[9px] flex items-center gap-1", mine ? "justify-end" : "justify-start")}>
      {mine && <MenuTrigger onOpen={openFromTrigger} />}
      <div
        class={cx(
          "msg-bubble max-w-[min(80%,540px)] rounded-card text-[14.5px] leading-normal shadow-soft transition-shadow max-md:max-w-[86%]",
          message.file ? "p-[7px]" : "px-[13px] py-[9px]",
          mine
            ? "rounded-br-[5px] bg-accent text-on-accent"
            : "rounded-bl-[5px] bg-surface text-ink dark:bg-surface-2",
          menu && "ring-2 ring-accent/50",
        )}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={cancelPress}
        onPointerCancel={cancelPress}
        onTouchEnd={onTouchEnd}
        onContextMenu={onContextMenu}
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
        {message.corrupted && (
          <div class="flex items-center gap-1.5 text-[13px] italic opacity-75 [&_svg]:size-[14px]">
            <AlertCircle class="flex-none" />
            Couldn&apos;t decrypt this message
          </div>
        )}
        {message.file && <FileAttachment message={message} mine={mine} />}
        <div
          class={cx(
            "mt-1 flex items-center justify-end gap-[5px] font-mono text-[10px] tracking-[0.03em] [&_svg]:size-[14px]",
            mine ? "text-on-accent/70" : "text-muted",
          )}
        >
          <span>{formatTime(message.createdAt)}</span>
          {mine && message.status === "queued" && <Clock aria-label="Waiting to send" />}
          {mine && message.status === "uploading" && (
            <Spinner class="!size-[12px] !border-[1.5px] !border-white/40 !border-t-white" />
          )}
          {mine && message.status === "sent" && <CheckCheck />}
          {mine && message.status === "failed" && (
            <>
              <AlertCircle class="!opacity-100" aria-label="Failed to send" />
              <button
                type="button"
                onClick={() => void retryMessage(message)}
                class="!opacity-100 font-medium underline underline-offset-2 hover:opacity-80"
              >
                Retry
              </button>
            </>
          )}
        </div>
      </div>
      {!mine && <MenuTrigger onOpen={openFromTrigger} />}
      {menu && (
        <MessageMenu
          message={message}
          anchor={menu}
          alignRight={mine}
          onClose={() => setMenu(null)}
        />
      )}
    </div>
  );
}

/**
 * Hover-revealed "⋮" button beside a bubble. Only rendered on devices with a
 * real pointer (`.msg-actions-trigger` is display:none elsewhere) — touch
 * users long-press the bubble instead.
 */
function MenuTrigger({
  onOpen,
}: {
  onOpen: (e: JSX.TargetedMouseEvent<HTMLButtonElement>) => void;
}): JSX.Element {
  return (
    <button
      type="button"
      aria-label="Message actions"
      title="Message actions"
      onClick={onOpen}
      class="msg-actions-trigger size-7 flex-none place-items-center rounded-full text-muted opacity-0 transition hover:bg-surface-3 hover:text-ink focus-visible:opacity-100 group-hover:opacity-100 [&_svg]:size-4"
    >
      <MoreVertical />
    </button>
  );
}

/** Human-readable transfer state for a file card. */
function fileStateLabel(message: LocalMessage): string | null {
  if (message.direction === "out") {
    switch (message.status) {
      case "queued":
        return "Waiting to upload";
      case "uploading":
        return "Uploading…";
      case "failed":
        return "Upload failed";
      default:
        return null;
    }
  }
  switch (message.fileState) {
    case "corrupted":
      return "Couldn't decrypt";
    case "expired":
      return "No longer available";
    default:
      return null;
  }
}

const ARCHIVE_MIME_RE = /zip|rar|7z|tar|gzip|compressed/;
const CODE_MIME_RE = /json|javascript|typescript|xml|html|css/;
const SPREADSHEET_MIME_RE = /spreadsheet|csv|excel|ms-excel/;
const DOCUMENT_MIME_RE = /pdf|msword|wordprocessing|rtf/;

/** Pick an icon that matches the attachment's MIME type. */
function FileTypeIcon({ mime }: { mime: string }): JSX.Element {
  if (mime.startsWith("image/")) return <FileImage />;
  if (mime.startsWith("video/")) return <FileVideo />;
  if (mime.startsWith("audio/")) return <FileAudio />;
  if (ARCHIVE_MIME_RE.test(mime)) return <FileArchive />;
  if (SPREADSHEET_MIME_RE.test(mime)) return <FileSpreadsheet />;
  if (CODE_MIME_RE.test(mime)) return <FileCode />;
  if (mime.startsWith("text/") || DOCUMENT_MIME_RE.test(mime)) return <FileText />;
  return <FileIcon />;
}

/**
 * Object URL for an image attachment's locally cached blob, or null while the
 * file is not an image / not downloaded yet. Revoked on unmount.
 */
function useImageThumbnail(file: FileRef, available: boolean): string | null {
  const [url, setUrl] = useState<string | null>(null);
  const isImage = file.mime.startsWith("image/");

  useEffect(() => {
    if (!isImage || !available) return;
    let objectUrl: string | null = null;
    let cancelled = false;
    void getFile(file.r2Key).then((blob) => {
      if (!blob || cancelled) return;
      objectUrl = URL.createObjectURL(blob);
      setUrl(objectUrl);
    });
    return () => {
      cancelled = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
      setUrl(null);
    };
  }, [file.r2Key, isImage, available]);

  return url;
}

function FileAttachment({ message, mine }: { message: LocalMessage; mine: boolean }): JSX.Element {
  const file = message.file!;
  const state = message.fileState;
  const stateLabel = fileStateLabel(message);
  const thumbnailUrl = useImageThumbnail(file, state === "downloaded");

  return (
    <div
      class={cx(
        "flex min-w-[240px] items-center gap-[11px] rounded-[10px] px-2.5 py-2",
        mine ? "bg-black/15" : "bg-surface-3",
      )}
    >
      {thumbnailUrl ? (
        <img
          src={thumbnailUrl}
          alt=""
          class="size-10 flex-none rounded-[10px] object-cover"
          loading="lazy"
        />
      ) : (
        <div
          class={cx(
            "grid size-10 flex-none place-items-center rounded-[10px] text-accent [&_svg]:size-5",
            mine ? "bg-white/90" : "bg-surface",
          )}
        >
          <FileTypeIcon mime={file.mime} />
        </div>
      )}
      <div class="min-w-0 flex-1">
        <div class="truncate text-[13.5px] font-medium" title={file.name}>
          {file.name}
        </div>
        <div class={cx("font-mono text-[11px] tracking-[0.02em]", mine ? "text-on-accent/70" : "text-muted")}>
          {formatBytes(file.size)}
          {stateLabel && ` · ${stateLabel}`}
        </div>
      </div>
      <div class="flex-none">
        {message.direction === "out" ? (
          message.status === "uploading" ? (
            <span class="grid size-[34px] place-items-center">
              <Spinner class={mine ? "!border-white/40 !border-t-white" : undefined} />
            </span>
          ) : message.status === "failed" ? (
            <IconButton
              label="Retry upload"
              class={cx("size-[34px]", mine && "text-white/90 hover:bg-white/15 hover:text-white")}
              onClick={() => void retryMessage(message)}
            >
              <RotateCw />
            </IconButton>
          ) : (
            <IconButton
              label="Save file"
              class={cx("size-[34px]", mine && "text-white/90 hover:bg-white/15 hover:text-white")}
              onClick={() => void saveFile(message)}
            >
              <Download />
            </IconButton>
          )
        ) : (
          <>
            {(state === "remote" || state === "downloading") && <Spinner />}
            {state === "downloaded" && (
              <IconButton
                label="Save file"
                class="size-[34px]"
                onClick={() => void saveFile(message)}
              >
                <Download />
              </IconButton>
            )}
            {state === "error" && (
              <IconButton
                label="Retry download"
                class="size-[34px]"
                onClick={() => void syncNow()}
              >
                <RotateCw />
              </IconButton>
            )}
            {(state === "corrupted" || state === "expired") && (
              <span
                class="grid size-[34px] place-items-center text-muted [&_svg]:size-[18px]"
                title={state === "corrupted" ? "Couldn't decrypt this file" : "File no longer available"}
              >
                <AlertCircle />
              </span>
            )}
          </>
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
