# Leo Tracker

A calm, mobile-first **baby tracker** for Leo — feeds, sleep, milestones — built as an
installable web app (PWA). Two parents share one login and see each other's entries live.

This is also Mike's **first Supabase project** and the **template** for future apps
(VisitCozumel, TierraMaya).

---

## The stack (and what each piece is)

| Piece | What it is | Where |
|-------|-----------|-------|
| **Front end** | The screen you tap — plain HTML/CSS/JS, no build step | `index.html`, `styles.css`, `app.js` |
| **Back end** | Supabase = a hosted Postgres **database** + **Auth** (logins) + **Realtime** (live sync) + **Storage** (photos) | supabase.com dashboard |
| **Schema** | The database blueprint (tables + security rules) | `schema.sql` |
| **PWA** | Makes it installable to the Home Screen | `manifest.webmanifest`, `sw.js`, `icons/` |
| **Config** | Which Supabase project to talk to (public keys) | `config.js` |

> **Key idea:** the front end is the same simple HTML I already ship to GitHub Pages. The
> *new* skill is the Supabase back end — that's where the real power (and learning) is.

---

## How the data works

Everything lives in ONE table, `events`. Each row is one thing that happened:

- `type` = `breast` · `bottle` · `sleep` · `milestone`
- `subtype` = for breast `left`/`right`; for sleep `nap`/`night`
- `start_at` / `end_at` — a row with **`end_at = null` is still running** (a live feed or
  current sleep). This is how both phones can show a live timer.
- `amount_ml` (bottles), `note` + `photo_url` (milestones), `created_by` (which parent).

**Row Level Security (RLS)** is on: only a logged-in family member can read or write. That's
why the public `anon` key in `config.js` is safe to ship.

---

## Setup (one time)

1. **Supabase project:** sign up at supabase.com → New Project.
2. **Run the schema:** dashboard → SQL Editor → paste `schema.sql` → Run.
3. **Storage:** create a bucket named `photos` (for milestone photos) + a policy letting
   logged-in users upload/read.
4. **Login:** create one shared family account (email + password) under Authentication.
5. **Keys:** Project Settings → API → copy **Project URL** + **anon public** key into
   `config.js`.

## Run it locally

PWAs must be *served*, not opened as a file:

```
cd ~/leo-tracker
npx serve .
```

Then open the printed `http://localhost:3000` address.

## Deploy

Push to a GitHub repo and enable **GitHub Pages** (same as `euro-trip-2026`). Open the HTTPS
link on your phone → Share → **Add to Home Screen**.

---

## Background push (wake-window alert when the app is closed)

The in-app banner ticks the wake timer while the app is open. To also get a lock-screen alert
at the 90-minute mark when the app is **closed**, set up Web Push (one time):

1. **Generate a VAPID keypair:** `npx web-push generate-vapid-keys`
2. **Public key →** `config.js` (`VAPID_PUBLIC_KEY`) — safe to ship.
3. **Secrets →** Supabase:
   `npx supabase secrets set VAPID_PUBLIC_KEY=... VAPID_PRIVATE_KEY=... VAPID_SUBJECT=mailto:you@example.com`
4. **Run the SQL:** SQL Editor → paste `schema-push.sql` → Run (creates `push_subscriptions` +
   `wake_alerts`). Then enable `pg_cron`/`pg_net` and run the scheduling block at the bottom of
   that file (fill in your project ref + key) so `wake-watch` fires every minute.
5. **Deploy the functions:** `npx supabase functions deploy ask-leo wake-watch --no-verify-jwt`
   (wake-watch is called by cron, so it skips JWT).
6. **On each phone:** open the installed app and tap 🔔 to grant alerts (this also stores the
   push subscription). **iPhone:** Web Push only works for a PWA **installed to the Home Screen
   via Safari** (iOS 16.4+).

> Note: a notification can't *tick* a live countdown — the OS tray can't run a timer. The live
> per-second countdown lives in the in-app banner; the push is a single alert at the 90-min mark.

---

## Reusing this for the next app

Copy the whole folder, then:
1. Write a new `schema.sql` for the new data and run it in a **new** Supabase project.
2. Point `config.js` at that new project.
3. Rebuild the screens in `index.html` + the logic in `app.js`.

The hard parts — login, RLS, realtime, photo upload, PWA install, deploy — carry over almost
unchanged.
