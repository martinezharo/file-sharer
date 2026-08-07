import { APP_PATH, navigate } from "./state/route";

interface InstalledAppLaunch {
  pathname: string;
  standaloneDisplayMode: boolean;
  iosStandalone: boolean;
}

/** Return the canonical app URL when an installed PWA is restored on the landing page. */
export function installedAppStartPath({
  pathname,
  standaloneDisplayMode,
  iosStandalone,
}: InstalledAppLaunch): string | undefined {
  if (pathname !== "/" || (!standaloneDisplayMode && !iosStandalone)) return undefined;
  return APP_PATH;
}

/** Keep the installed experience inside the app even when the browser restores `/`. */
export function redirectInstalledAppFromLanding(): void {
  const startPath = installedAppStartPath({
    pathname: location.pathname,
    standaloneDisplayMode: window.matchMedia("(display-mode: standalone)").matches,
    // Safari exposes installed Home Screen apps through this non-standard flag.
    iosStandalone: (navigator as Navigator & { standalone?: boolean }).standalone === true,
  });

  if (startPath) navigate(startPath, { replace: true });
}
