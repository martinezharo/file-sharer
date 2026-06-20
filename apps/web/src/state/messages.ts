import { signal } from "@preact/signals";
import { allMessages, putMessage } from "../db/store";
import type { LocalMessage } from "../types";

export const messages = signal<LocalMessage[]>([]);

export async function loadMessages(): Promise<void> {
  messages.value = await allMessages();
}

/** Insert or update a message both in IndexedDB and the reactive signal. */
export async function upsertMessage(message: LocalMessage): Promise<void> {
  await putMessage(message);
  const next = messages.value.filter((m) => m.id !== message.id);
  next.push(message);
  next.sort((a, b) => a.createdAt - b.createdAt);
  messages.value = next;
}

export function getLocalMessage(id: string): LocalMessage | undefined {
  return messages.value.find((m) => m.id === id);
}
