/**
 * Extraction of files out of a `DataTransfer`, shared by the paste handler and
 * the drag & drop overlay. Both browser APIs hand us the same object shape, but
 * with different expectations: a paste should only pull in images (the text
 * flavour of the clipboard is the message), while a drop takes everything the
 * user dragged in, folders included.
 */

type ClipboardFileSource = Pick<DataTransfer, "files" | "items">;

/** Extract pasted images without treating their text representation as a message. */
export function getClipboardImages(data: ClipboardFileSource | null): File[] {
  if (!data) return [];

  const itemImages = Array.from(data.items).flatMap((item) => {
    if (item.kind !== "file") return [];
    const file = item.getAsFile();
    return file?.type.startsWith("image/") ? [file] : [];
  });

  // `files` covers browsers that expose clipboard files without usable items.
  if (itemImages.length > 0) return itemImages;
  return Array.from(data.files).filter((file) => file.type.startsWith("image/"));
}

/**
 * Whether a drag carries files. Dragging selected text or a link fires the same
 * events, and those must keep their native behaviour.
 */
export function hasTransferFiles(data: Pick<DataTransfer, "types"> | null): boolean {
  return !!data && Array.from(data.types ?? []).includes("Files");
}

/** Stop walking a dropped folder tree this deep, so no cycle can hang the read. */
const MAX_DIRECTORY_DEPTH = 8;

/**
 * All files in a drop, expanding dropped folders into their contents.
 *
 * `items` is only readable synchronously inside the event handler, so the
 * entries are snapshotted before the first `await`. Browsers without the entry
 * API fall back to the flat file list (where folders are simply absent).
 */
export function getDroppedFiles(data: DataTransfer | null): Promise<File[]> {
  if (!data) return Promise.resolve([]);

  const entries: FileSystemEntry[] = [];
  for (const item of Array.from(data.items ?? [])) {
    if (item.kind !== "file") continue;
    const entry = item.webkitGetAsEntry?.();
    if (entry) entries.push(entry);
  }

  if (entries.length === 0) return Promise.resolve(Array.from(data.files ?? []));
  return collectEntries(entries, 0);
}

async function collectEntries(entries: FileSystemEntry[], depth: number): Promise<File[]> {
  const nested = await Promise.all(entries.map((entry) => collectEntry(entry, depth)));
  return nested.flat();
}

async function collectEntry(entry: FileSystemEntry, depth: number): Promise<File[]> {
  if (entry.isFile) {
    const file = await readEntryFile(entry as FileSystemFileEntry);
    if (!file) return [];
    // Keep the folder structure in the name: two `photo.jpg` coming from
    // different dropped folders would otherwise be indistinguishable in chat.
    const path = entry.fullPath.replace(/^\/+/, "");
    return [!path || path === file.name ? file : new File([file], path, { type: file.type })];
  }
  if (!entry.isDirectory || depth >= MAX_DIRECTORY_DEPTH) return [];
  return collectEntries(await readDirectory(entry as FileSystemDirectoryEntry), depth + 1);
}

function readEntryFile(entry: FileSystemFileEntry): Promise<File | null> {
  return new Promise((resolve) => {
    entry.file(resolve, () => resolve(null));
  });
}

/** `readEntries` yields a directory in batches; keep reading until it runs dry. */
async function readDirectory(entry: FileSystemDirectoryEntry): Promise<FileSystemEntry[]> {
  const reader = entry.createReader();
  const all: FileSystemEntry[] = [];

  for (;;) {
    const batch = await new Promise<FileSystemEntry[]>((resolve) => {
      reader.readEntries(resolve, () => resolve([]));
    });
    if (batch.length === 0) return all;
    all.push(...batch);
  }
}
