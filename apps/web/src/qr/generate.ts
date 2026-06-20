import QRCode from "qrcode";

/** Render a QR code for `text` into a canvas element. */
export async function renderQrToCanvas(canvas: HTMLCanvasElement, text: string): Promise<void> {
  await QRCode.toCanvas(canvas, text, {
    margin: 2,
    width: 240,
    errorCorrectionLevel: "M",
    color: { dark: "#0b141aff", light: "#ffffffff" },
  });
}
