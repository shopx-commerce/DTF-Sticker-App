---
title: Commit and push to GitHub
---
# Commit and Push to GitHub

## What & Why
Commit all current uncommitted changes on the main branch and push them to the connected GitHub remote so the recent gang sheet bug fixes (no-cut-path support, preview cut line gating) are persisted to the user's repository.

## Done looks like
- All staged and unstaged changes in the working tree are committed with a clear message describing the recent gang sheet "no cut path" feature work.
- The local `main` branch is pushed to the GitHub remote.
- `git status` reports a clean working tree and the local branch is up to date with the remote.

## Out of scope
- Creating pull requests, branches, tags, or releases.
- Any code changes — this is a commit/push operation only.
- Modifying git history (no rebase, no amend, no force push).

## Steps
1. Review the working tree and stage all current changes.
2. Create a single commit summarizing the recent work: enabling "Add to Gang Sheet" without an active contour or shape, hiding the magenta cut line in both the gang sheet PDF export and the on-screen preview thumbnail for items flagged `noCutPath`, and driving that flag from user settings rather than stale cached contour data.
3. Push the local `main` branch to the configured GitHub remote.
4. Verify the push succeeded and the working tree is clean.

## Relevant files
- `client/src/components/image-editor.tsx`
- `client/src/components/gang-sheet-panel.tsx`
- `client/src/lib/gang-sheet.ts`