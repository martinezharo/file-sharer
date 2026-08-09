# AGENTS.md
## Project
file-sharer is the temporary name for a web app designed to share files and text between your own devices in a fast and intuitive way, with a UI/UX closer to a messaging app than to other tools with the same purpose.
This repository is a VERY EARLY WIP. Proposing sweeping changes that improve long-term maintainability is encouraged.
## Key features
* Connect your devices once and forget about it.
* You can share your stuff without the other devices needing to be online, just like you would on WhatsApp or Telegram.
## Priorities
* Optimal performance on both frontend and backend.
* Excellent security and privacy, as long as it doesn't hurt UX too much.
## Maintainability
Long term maintainability is a core priority. If you add new functionality, first check if there is shared logic that can be extracted to a separate module. Duplicate logic across multiple files is a code smell and should be avoided. Don't be afraid to change existing code. Don't take shortcuts by just adding local logic to solve a problem.
## Typography
Text is sized from the named scale in `apps/web/src/styles.css` (`text-meta` … `text-display-lg`), never with an arbitrary `text-[Npx]`. Two reasons: the tokens are in `rem`, so they follow the reader's browser font-size preference, and a scale of eleven named steps can be retuned in one place. The floor is 11px, and any text-entry field must reach 16px on mobile or iOS Safari zooms the viewport on focus.
Secondary copy on an accent fill uses `text-on-accent-muted`, not `text-on-accent` at reduced alpha — the accent barely clears 4.5:1 with full-strength text, so alpha puts it under the contrast minimum.