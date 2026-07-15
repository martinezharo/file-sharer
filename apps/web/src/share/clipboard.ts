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
