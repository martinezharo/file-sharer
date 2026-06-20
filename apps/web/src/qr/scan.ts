import jsQR from "jsqr";

export interface Scanner {
  stop(): void;
}

interface BarcodeDetectorLike {
  detect(source: CanvasImageSource): Promise<{ rawValue: string }[]>;
}

/**
 * Start scanning QR codes from the device camera into `video`. Uses the native
 * BarcodeDetector when available, falling back to jsQR over canvas frames.
 * Calls `onResult` once with the first decoded value, then pauses (the caller
 * should `stop()`).
 */
export async function startScanner(
  video: HTMLVideoElement,
  onResult: (text: string) => void,
  onError: (error: Error) => void,
): Promise<Scanner> {
  let stopped = false;
  let stream: MediaStream | null = null;
  let raf = 0;

  const DetectorCtor = (globalThis as { BarcodeDetector?: new (opts: { formats: string[] }) => BarcodeDetectorLike })
    .BarcodeDetector;
  const detector = DetectorCtor ? new DetectorCtor({ formats: ["qr_code"] }) : null;

  try {
    stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: "environment" },
      audio: false,
    });
    video.srcObject = stream;
    video.setAttribute("playsinline", "true");
    await video.play();
  } catch (error) {
    onError(error instanceof Error ? error : new Error("Camera unavailable"));
    return { stop() {} };
  }

  const canvas = document.createElement("canvas");
  const ctx = canvas.getContext("2d", { willReadFrequently: true });

  const tick = async (): Promise<void> => {
    if (stopped) return;
    if (video.readyState >= 2 && video.videoWidth > 0 && ctx) {
      try {
        if (detector) {
          const codes = await detector.detect(video);
          if (codes[0]?.rawValue) {
            onResult(codes[0].rawValue);
            return;
          }
        } else {
          canvas.width = video.videoWidth;
          canvas.height = video.videoHeight;
          ctx.drawImage(video, 0, 0);
          const image = ctx.getImageData(0, 0, canvas.width, canvas.height);
          const result = jsQR(image.data, image.width, image.height);
          if (result?.data) {
            onResult(result.data);
            return;
          }
        }
      } catch {
        /* ignore transient frame decode errors */
      }
    }
    raf = requestAnimationFrame(() => void tick());
  };

  raf = requestAnimationFrame(() => void tick());

  return {
    stop() {
      stopped = true;
      cancelAnimationFrame(raf);
      stream?.getTracks().forEach((track) => track.stop());
      video.srcObject = null;
    },
  };
}
