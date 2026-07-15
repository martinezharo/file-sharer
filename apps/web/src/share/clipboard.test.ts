import { describe, expect, it } from "vitest";
import { getClipboardImages } from "./clipboard";

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
