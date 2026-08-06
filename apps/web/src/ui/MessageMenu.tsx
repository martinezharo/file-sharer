import { Copy, Share2, Trash2, Users } from "lucide-preact";
import type { JSX } from "preact";
import { useState } from "preact/hooks";
import {
  canDeleteEverywhere,
  canShareMessage,
  copyMessageText,
  deleteMessageEverywhere,
  deleteMessageLocally,
  shareMessage,
} from "../actions";
import type { LocalMessage } from "../types";
import { type MenuAnchor, Menu, MenuItem, MenuSeparator } from "./Menu";
import { Button, Modal } from "./components";

/**
 * Per-message context menu, opened from the message's own button, a long-press
 * or a right-click.
 */
export function MessageMenu({
  message,
  anchor,
  alignRight,
  onClose,
}: {
  message: LocalMessage;
  anchor: MenuAnchor;
  alignRight: boolean;
  onClose: () => void;
}): JSX.Element {
  // Deleting everywhere is the one action here that cannot be undone and that
  // reaches beyond this device, so it is confirmed. The confirmation replaces
  // the menu rather than opening on top of it: the menu's backdrop sits above
  // the dialog layer, and dismissing the menu first would take the dialog with
  // it.
  const [confirmingGlobalDelete, setConfirmingGlobalDelete] = useState(false);

  function run(action: (message: LocalMessage) => Promise<void>): void {
    onClose();
    void action(message);
  }

  if (confirmingGlobalDelete) {
    return (
      <Modal title="Delete on all devices?" onClose={onClose}>
        <div class="px-5 pb-5 pt-1 text-sm leading-relaxed text-muted">
          <p>
            This message will be removed from every device linked to this space, including the ones
            that are offline right now — they&apos;ll delete it as soon as they reconnect.
          </p>
          <p class="mt-3">
            {message.file
              ? "A device that already saved this file elsewhere keeps that copy. This can't be undone."
              : "This can't be undone."}
          </p>
          <div class="mt-5 flex flex-col gap-2 sm:flex-row sm:justify-end">
            <Button class="sm:w-auto" variant="secondary" onClick={onClose}>
              Cancel
            </Button>
            <Button class="sm:w-auto" variant="danger" onClick={() => run(deleteMessageEverywhere)}>
              Delete everywhere
            </Button>
          </div>
        </div>
      </Modal>
    );
  }

  return (
    <Menu anchor={anchor} alignRight={alignRight} label="Message actions" onClose={onClose}>
      {message.text && (
        <MenuItem icon={<Copy />} onClick={() => run(copyMessageText)}>
          Copy text
        </MenuItem>
      )}
      {canShareMessage(message) && (
        <MenuItem icon={<Share2 />} onClick={() => run(shareMessage)}>
          Share…
        </MenuItem>
      )}
      {(message.text || canShareMessage(message)) && <MenuSeparator />}
      <MenuItem danger icon={<Trash2 />} onClick={() => run(deleteMessageLocally)}>
        Delete on this device
      </MenuItem>
      {/* Hidden entirely when no other device can be holding a copy — an entry
          that would do nothing beyond the one above it is worse than no entry
          at all. See `canDeleteEverywhere`. */}
      {canDeleteEverywhere(message) && (
        <MenuItem danger icon={<Users />} onClick={() => setConfirmingGlobalDelete(true)}>
          Delete on all devices
        </MenuItem>
      )}
    </Menu>
  );
}
