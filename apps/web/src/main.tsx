import { render } from "preact";
import { resumeLinking } from "./actions";
import { loadMessages } from "./state/messages";
import { loadSession, session } from "./state/session";
import { startSync } from "./sync/sync";
import { App } from "./ui/App";
import "./styles.css";

async function bootstrap(): Promise<void> {
  await loadSession();
  if (session.value) {
    await loadMessages();
    startSync();
  } else {
    await resumeLinking();
  }
}

const root = document.getElementById("app");
if (root) {
  render(<App />, root);
}

void bootstrap();
