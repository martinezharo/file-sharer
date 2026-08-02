import render from "preact-render-to-string";
import { Landing } from "./ui/Landing";

/** Render the public marketing page into the HTML served before the app boots. */
export function renderLanding(): string {
  return render(<Landing />);
}
