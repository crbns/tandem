# Web dashboard: gate status

Person 3's checklist from the build brief. `PASS` = verified in this repo; `PENDING (backend)` = blocked on Person 2's Convex functions.

> **Backend state (Oct 23):** `packages/backend/convex/` contains only an empty `schema.ts`. There are no functions and no `_generated/api`. Per conflict rule 3, the whole dashboard runs in mock mode; Convex wiring is `PENDING (backend)`. See `CONTRACT_NOTES.md`.

## Gate 1: shell, routing, auth

| Check | Status | Notes |
|---|---|---|
| Dev server runs; `/` redirects signed-in and signed-out (mock) | PASS | `/` → `/sign-in` signed out; → `/w/<id>` signed in |
| Sign-in/out in mock mode | PASS | bad password shows "Email or password is incorrect."; sign-out returns to `/sign-in`; `/w/*` signed out → `/sign-in?next=…` |
| Real-mode providers + proxy compile | PASS (typecheck) | Functional check is `PENDING (backend)`: no Convex Auth config yet |
| Typecheck + lint | PASS | |
