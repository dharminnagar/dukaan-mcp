# Recording runbook, DUK-22

This document gives the exact commands for each shot. The words to speak
are in `docs/video-script.md`. This document does not repeat them; it only
covers what to run and what should appear on screen. Read both together.

Run every step below once, start to finish, before the first real take.
A dry run finds a broken command before the camera is rolling.

## Before you start recording

```bash
bun run db:up
bun run db:migrate
```

Confirm Postgres is up and migrations applied with no errors.

Set the terminal font size before you record anything, not after. Your
normal size is not readable at 720p. Bump it now, in the same terminal
window you will record in.

Confirm `.env` has real `RAZORPAY_KEY_ID` and `RAZORPAY_KEY_SECRET` set,
Test Mode. Shot 4 needs a real `order_` id, which needs a real
Razorpay API call to succeed.

Register a buyer account and sign in before you start recording.
Registration and sign-in are not shown on camera — shot 3 assumes you
are already signed in. That buyer must NOT already be connected to
`m_demo_merchant_a`, or `/buyer/stores` shows "Regenerate token"
instead of "Connect" for that row. Either button produces the same
on-screen result (a fresh token), so if it is already connected,
"Regenerate token" is a fine substitute for shot 3 — just do not say
"connect" out loud if the button on screen says "Regenerate."

Open two terminal windows or tabs before you start:

- one for `bun run mcp:dev`
- one for the shot commands below

Open two browser tabs before you start:

- the web app, for onboarding and the audit view
- the Razorpay dashboard, Test Mode, Orders, already logged in

---

## Shot 1: on-camera cold open

No command. Camera only. See `docs/video-script.md`, Act 1.

---

## Shot 2: onboarding screen

Start the web app if it is not already running:

```bash
bun run web:dev
```

On screen, in the browser:

1. Open the onboarding page.
2. Upload `fixtures/demo-merchant-a.csv`. Do not use `shopify-export.csv`.
3. On the policy step, untick `personal-care` and `beverages`. The form
   starts with every category ticked. This step must be visible on camera,
   or the block in shot 4 never fires.
4. Set the spend cap and approval threshold fields to match
   `fixtures/demo-merchant-a.policy.json`: spend cap ₹5,000, approval
   threshold ₹1,500.
5. Submit. This mints the merchant. You do not need this token for
   anything later — shot 4 uses the buyer's own token from shot 3, not
   this one.

---

## Shot 3: buyer connect

In the browser, on the web app, already signed in as the buyer:

1. Open `/buyer/stores`.
2. Find `Demo Merchant A` (`m_demo_merchant_a`) in the list.
3. Click Connect (or Regenerate token, if this buyer is already
   connected from an earlier rehearsal take — same on-screen result).
4. The token appears once, with the connect-instructions copy under
   it. Copy the token now. You need it for shot 4.

No new command — this reads and writes against the same database and
web app already running from shot 2.

---

## Shot 4: terminal, agent trace and the re-plan

In the second terminal, with `mcp:dev` already running in the first:

```bash
DEMO_TOKEN='<paste the token from shot 3>' bun run demo:client
```

This script is `scripts/demo-client.ts`, a real MCP client (the same
package the test suite and `spike-client.ts` use). It:

1. Lists the catalog.
2. Attempts checkout on Lifebuoy Handwash 500ml, `personal-care`. The
   gate blocks this and prints `BLOCKED: CATEGORY_NOT_ALLOWED`. Let this
   line sit on screen. Do not talk over it.
3. Prints `re-planning: picking an allowed item instead`.
4. Checks out Cadbury Dairy Milk 100g, `snacks`. This succeeds and prints
   the order id and the real Razorpay order id.

Write down the Razorpay order id it prints. You need it for shot 6.

If the script exits with `FAIL`, the token from shot 3 was pasted wrong,
or `mcp:dev` is not running. Fix that before moving on. Do not record over
a failed run.

---

## Shot 5: audit view

In the browser, on the web app:

1. Open the audit view for this session.
2. Both rows from shot 4 are visible: the blocked `CATEGORY_NOT_ALLOWED`
   row, and the `ALLOWED` row with the order id from shot 4.

Quick cut, do not linger here — this shot is scripted at 10 seconds, half
of what it used to be, to make room for shot 3.

No command. This reads from the same database shots 2-4 wrote to.

---

## Shot 6: Razorpay dashboard

In the browser, on the already-open Razorpay dashboard:

1. Go to Test Mode, Orders.
2. Find the order id you wrote down at the end of shot 4.
3. Have that order id on screen, matched against the id from shot 4 and
   shot 5.

No command. This is the real order shot 4's checkout created.

---

## Shot 7: metrics table

In the second terminal:

```bash
bun run eval:report
```

Run this with no arguments. This prints the train-split report only. Do
not run `bun run eval:report --split=holdout`. That run is reserved and
is not for this video.

Let the full table sit on screen long enough to read while you speak the
escapes named in `docs/video-script.md`, Act 2, "Metrics table, say the
escapes out loud."

---

## Shot 8: on-camera close

No command. Camera only. See `docs/video-script.md`, Act 3.

---

## After recording

- Edit to 5:00 or under.
- Upload, get a shareable link.
- Open the link in a private browsing window, logged out of everything,
  and watch it end to end. A video that only plays for you is a failed
  submission.
- Watch it once at 720p on a phone. Confirm the terminal text in shot 4
  and shot 7 is still legible at that size.
