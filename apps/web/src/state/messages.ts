import { signal } from "@preact/signals";
import { allMessages, putMessage } from "../db/store";
import type { LocalMessage } from "../types";

export const messages = signal<LocalMessage[]>([]);

export async function loadMessages(): Promise<void> {
  messages.value = await allMessages();
}

/**
 * Update the in-memory signal only. Used when the message is already persisted
 * (e.g. the service worker flushed the outbox and broadcast the new state).
 */
export function applyMessageUpdate(message: LocalMessage): void {
  const next = messages.value.filter((m) => m.id !== message.id);
  next.push(message);
  next.sort((a, b) => a.createdAt - b.createdAt);
  messages.value = next;
}

/** Insert or update a message both in IndexedDB and the reactive signal. */
export async function upsertMessage(message: LocalMessage): Promise<void> {
  await putMessage(message);
  applyMessageUpdate(message);
}

export function getLocalMessage(id: string): LocalMessage | undefined {
  return messages.value.find((m) => m.id === id);
}
