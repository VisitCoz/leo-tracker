# Leo Tracker — build prompt (paste into Lovable or bolt.new)

Build a **mobile-first baby-tracking PWA called "Leo Tracker."** Calm dark theme (deep
plum/charcoal background, warm pink + sage accents, a serif display font like Fraunces for
headings, a clean sans for body). One-handed use, big tap targets — it's used at 3am.

## Backend
Use **Supabase** (connect my project). All data lives in a table called `events` with columns:
`id, type, subtype, start_at, end_at, amount_ml, note, photo_url, created_by, created_at`.
- `type` is one of: `breast`, `bottle`, `sleep`, `milestone`
- `subtype`: for breast = `left`/`right`; for sleep = `nap`/`night`
- A row with `end_at = null` means it is still running (a live feed or current sleep).

Use Supabase **Auth** (email login). Two parents share ONE account/data set.
Use Supabase **Realtime** on `events` so when one parent logs something, the other parent's
screen updates instantly with no refresh.

## Core features

1. **Wake-window timer (the headline feature).**
   - Big live timer counting how long Leo has been awake since the last sleep ended.
   - ⚠️ **SUPERSEDED — do not build from the numbers below.** This file is the original
     June 2026 build prompt, kept for history. It hardcoded a 90-minute wake window and
     zones at 75/90/105; those were right at 3 months, wrong by 6, and the app went on
     telling us to put a not-tired baby to bed for months. Every number now comes from
     `AGE_DEFAULTS` in `app.js` ("0b. SLEEP MODEL"), is chosen by Leo's age automatically,
     and is overridable in Sleep settings. If you are reimplementing the timer, read that
     section — not this one.
   - The window is displayed as a **range** ("Window: 7:20 – 7:50 PM"), never a single
     cliff time. A single time reads as a deadline and produces panic put-downs.

2. **Feed logging with a running timer.**
   - "Breast L" and "Breast R" buttons START a live feed timer (show a running m:ss banner).
     Tapping the same side again STOPS it and saves the duration. Tapping the other side
     switches sides (stops current, starts new).
   - "Bottle" button asks for ml using an **in-app modal input** and saves instantly.
   - Show "time since last feed" prominently.

3. **Sleep.** A Start/End sleep button. Auto-tag `night` if start time is 7pm–7am, else `nap`.
   Show the running sleep duration while asleep.

4. **Milestones.** A button to add a "first/milestone": text note + **optional photo upload**
   (store the image in a Supabase Storage bucket named `photos`, save its URL to `photo_url`).

5. **Today summary:** three tiles — feeds count, total sleep, total feed time.

6. **Today's log:** reverse-chronological list of all events with their durations; allow delete.

7. **CSV export** of all events.

## Hard requirements (these caused bugs before)
- **Do NOT use `prompt()`, `alert()`, or `confirm()`** — they get blocked. Use in-app modals
  for any text/number input and inline UI for confirmations.
- Wire every button with proper event listeners (no inline onclick).
- Make it an installable **PWA** (manifest + service worker) so it can be added to the Home
  Screen on iPhone and Android.
- Mobile-first layout, max width ~520px, large buttons.

## Later (don't build yet, just leave room)
- Background push notifications when the app is closed.
- A weekly AI summary of Leo's patterns.
