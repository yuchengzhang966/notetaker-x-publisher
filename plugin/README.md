# X Articles drafts

Adds "Create X draft" to the document title menu (click the document icon next to the title) and to the command palette.
Needs the local service from `~/Project/siyuan-x-publisher` (`npm start`).

The plugin only makes drafts. It never publishes. Review the draft in X and publish it there yourself.

Status is stored on the document as attributes: `custom-x-status`, `custom-x-draft-url`, `custom-x-error`.
Set `custom-x-cover` to an asset path (for example `assets/cover-2026.png`) to use a cover image.
