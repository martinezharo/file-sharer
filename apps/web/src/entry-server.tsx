import render from "preact-render-to-string";
import { Landing } from "./ui/Landing";
import { Loading } from "./ui/components";

/**
 * The two documents this site is built from.
 *
 * `/` is the public marketing page, prerendered so crawlers and no-JS clients
 * get real HTML. `/app` is the application, and it is prerendered as the
 * app's own loading screen — never as the marketing page. Serving one document
 * for both is what used to make the installed app flash the landing page on
 * every launch: the shell painted before the bundle had booted, and the shell
 * was the landing.
 */

/** The public marketing page, as served at `/`. */
export function renderLanding(): string {
  return render(<Landing prerendered />);
}

/** The app's first paint, as served at `/app` and everything under it. */
export function renderAppShell(): string {
  return render(<Loading />);
}
