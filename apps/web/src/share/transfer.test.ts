import { describe, expect, it } from "vitest";
import { getClipboardImages, getDroppedFiles, hasTransferFiles } from "./transfer";

function clipboardData({
  items = [],
  files = [],
}: {
  items?: Array<{ kind: string; getAsFile: () => File | null }>;
  files?: File[];
}): Pick<DataTransfer, "files" | "items"> {
  return { items, files } as unknown as Pick<DataTransfer, "files" | "items">;
}

function file(type: string): File {
  return { type } as File;
}

describe("getClipboardImages", () => {
  it("returns no files when clipboard data is unavailable", () => {
    expect(getClipboardImages(null)).toEqual([]);
  });

  it("extracts only images from clipboard items", () => {
    const image = file("image/png");
    const document = file("application/pdf");

    expect(
      getClipboardImages(
        clipboardData({
          items: [
            { kind: "string", getAsFile: () => null },
            { kind: "file", getAsFile: () => document },
            { kind: "file", getAsFile: () => image },
          ],
        }),
      ),
    ).toEqual([image]);
  });

  it("falls back to the clipboard file list when items have no usable image", () => {
    const image = file("image/jpeg");

    expect(
      getClipboardImages(
        clipboardData({
          items: [{ kind: "file", getAsFile: () => null }],
          files: [file("text/plain"), image],
        }),
      ),
    ).toEqual([image]);
  });

  it("does not duplicate images exposed through both clipboard collections", () => {
    const image = file("image/webp");

    expect(
      getClipboardImages(
        clipboardData({
          items: [{ kind: "file", getAsFile: () => image }],
          files: [image],
        }),
      ),
    ).toEqual([image]);
  });
});

function realFile(name: string): File {
  return new File(["x"], name, { type: "text/plain" });
}

function fileEntry(fullPath: string, file: File): FileSystemEntry {
  return {
    isFile: true,
    isDirectory: false,
    fullPath,
    file: (resolve: (f: File) => void) => resolve(file),
  } as unknown as FileSystemEntry;
}

/** `readEntries` is drained in batches, so hand it one batch then an empty one. */
function directoryEntry(children: FileSystemEntry[]): FileSystemEntry {
  return {
    isFile: false,
    isDirectory: true,
    createReader: () => {
      let done = false;
      return {
        readEntries: (resolve: (entries: FileSystemEntry[]) => void) => {
          resolve(done ? [] : children);
          done = true;
        },
      };
    },
  } as unknown as FileSystemEntry;
}

function dropData({
  entries = [],
  files = [],
}: {
  entries?: (FileSystemEntry | null)[];
  files?: File[];
}): DataTransfer {
  return {
    types: ["Files"],
    items: entries.map((entry) => ({ kind: "file", webkitGetAsEntry: () => entry })),
    files,
  } as unknown as DataTransfer;
}

describe("hasTransferFiles", () => {
  it("detects a drag carrying files", () => {
    expect(hasTransferFiles({ types: ["Files"] } as unknown as DataTransfer)).toBe(true);
  });

  it("ignores drags of text or links", () => {
    expect(hasTransferFiles(null)).toBe(false);
    expect(
      hasTransferFiles({ types: ["text/plain", "text/uri-list"] } as unknown as DataTransfer),
    ).toBe(false);
  });
});

describe("getDroppedFiles", () => {
  it("returns no files when the drop carries no data", async () => {
    await expect(getDroppedFiles(null)).resolves.toEqual([]);
  });

  it("reads dropped files through their entries", async () => {
    const file = realFile("notes.txt");

    await expect(
      getDroppedFiles(dropData({ entries: [fileEntry("/notes.txt", file)] })),
    ).resolves.toEqual([file]);
  });

  it("expands dropped folders and keeps their path in the file name", async () => {
    const nested = realFile("photo.jpg");
    const folder = directoryEntry([fileEntry("/trip/photo.jpg", nested)]);

    const result = await getDroppedFiles(dropData({ entries: [folder] }));

    expect(result).toHaveLength(1);
    expect(result[0]?.name).toBe("trip/photo.jpg");
    expect(result[0]?.size).toBe(nested.size);
  });

  it("falls back to the flat file list when entries are unavailable", async () => {
    const file = realFile("legacy.txt");

    await expect(getDroppedFiles(dropData({ entries: [null], files: [file] }))).resolves.toEqual([
      file,
    ]);
  });
});
