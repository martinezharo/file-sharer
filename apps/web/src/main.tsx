import { render } from "preact";
import { resumeLinking } from "./actions";
import { consumeSharedContent } from "./share/incoming";
import { loadMessages } from "./state/messages";
import { loadSession, session } from "./state/session";
import { startSync } from "./sync/sync";
import { App } from "./ui/App";
import "@fontsource-variable/bricolage-grotesque/wght.css";
import "@fontsource-variable/hanken-grotesk/wght.css";
import "@fontsource-variable/jetbrains-mono/wght.css";
import "./styles.css";

async function bootstrap(): Promise<void> {
  await loadSession();
  if (session.value) {
    await loadMessages();
    startSync();
  } else {
    await resumeLinking();
  }
  await consumeSharedContent();
}

const root = document.getElementById("app");
if (root) {
  render(<App />, root);
}

void bootstrap();
