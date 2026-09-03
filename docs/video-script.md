# DUK-22, video script and shot list

Draft. Not committed. Time it aloud with a stopwatch before recording.
A script that feels like five minutes reads as seven.

Structure: an on-camera cold open, then a screen-capture investigation,
then an on-camera close. Documentary pacing. Short declarative lines.
Real pauses. The script states the problem like a finding. It does not
pitch the problem.

The introduction comes after the hook, not before it. The first thing
the viewer hears is the handwash failure, not a name. Saying "Hello, I
am Dharmin" at 0:00 turns this into the project-tour video this format
exists to avoid. Three sentences of introduction at 0:30, once the
viewer already wants to know who found this, cost eight seconds and
read as credentials rather than as a preamble.

Target: 5:00 total. 5:00 is the hard ceiling.

The cold open names the handwash checkout by name before the viewer
sees it happen. Act 2 shows that exact checkout blocked. Act 3 names
it again to close the loop. This repetition is deliberate, not an
accidental echo. Do not remove it while editing for time.

---

## Shot list (record these, in this order)

1. On-camera, cold open. You, mid-thought, stating the problem. No
   slate, no logo card first.
2. Onboarding screen. Upload `fixtures/demo-merchant-a.csv`. Fill in
   the policy form. Untick `personal-care` and `beverages` on camera.
   The form starts with every category ticked. You must untick these
   two categories, or the block does not fire later. Submit the form.
   The screen shows the token once.
3. Buyer connect. Already signed in as a buyer (sign-in itself is not
   shown, off camera before recording starts). Open `/buyer/stores`,
   click Connect on the demo merchant. The token appears once. Quick
   beat, do not linger. This is the token shot 4 uses, not the
   merchant's onboarding token from shot 2 — the whole point is that
   it carries the buyer's own cap, not the merchant's.
4. Terminal, the agent trace. Use a real MCP client, not a custom
   script. The client connects with the token from shot 3. It lists
   products. It attempts checkout on `sku-a22`, Lifebuoy Handwash
   500ml, category `personal-care`. The gate returns the
   `CATEGORY_NOT_ALLOWED` tool error. The agent re-plans. It picks an
   allowed item. It checks out again. This checkout succeeds. Increase
   the terminal font size before you record. Your normal font size is
   not readable at 720p.
5. Audit view. The two rows from that session: the blocked
   `CATEGORY_NOT_ALLOWED` row, and the `ALLOWED` row with the order
   id. Quick cut, do not linger.
6. Razorpay dashboard, Test Mode, Orders. The same `order_` id from
   shot 4 and shot 5, visible on screen, matched to a real
   API-created order.
7. Terminal, run `bun run eval:report` with no `--split` flag. This
   command prints the train-split report. Do not run
   `--split=holdout`. That run is reserved. Let the full table stay on
   screen.
8. On-camera, close. State the vouching thesis. Scope the claim to
   India and UPI. Name Shopify UCP and Stripe ACS. Mention the two
   open Razorpay tickets. Speak the final line.

## Rehearsal notes (from DUK-22, verified while scripting)

- The onboarding form defaults to every category ticked. If you accept
  the defaults, the policy allows `personal-care`, and the handwash
  block does not fire. Untick `personal-care` and `beverages` on
  camera before you submit the form.
- Use `fixtures/demo-merchant-a.csv`. Do not use `shopify-export.csv`.
  The Shopify fixture lists only `staples`, `dairy`, and `household`.
  It cannot demonstrate a category block.
- The policy for `demo-merchant-a` sets a spend cap of ₹5,000, an
  approval threshold of ₹1,500, and an allowlist of `staples`,
  `dairy`, `snacks`, and `household`. `sku-a22`, Lifebuoy Handwash,
  ₹89, has category `personal-care`. This category is outside the
  allowlist. The price is low enough that only the category rule can
  cause the block.
- Run `bun run eval:report` with no arguments, on camera. This command
  prints the train split only. `--split=holdout` is the one scored
  run. Do not spend that run for this video.
- **Act 3 states the payment constraint. It does not complain about
  it.** Razorpay is the audience for this video, so "Razorpay has not
  granted my ticket" is both rude and wrong. BharatQR is deprecated
  platform-wide, and server-to-server access needs PCI-DSS
  certification. Support answered both. Neither answer is a delay, and
  the underlying limit is regulation rather than any company's policy.
  Name the constraint, agree it is reasonable, move on. Do not
  reintroduce a grievance here while editing for time.
- Have a buyer account already registered and signed in before you
  start recording — registration and sign-in are not shown on camera.
  That buyer must not already be connected to the demo merchant, or
  the Connect button in shot 3 is replaced by "Regenerate token"
  instead of "Connect." Either button produces the same on-screen
  result (a fresh token), so if you forgot to disconnect first, using
  Regenerate is a fine substitute — just say "connect" in your own
  head, not on camera, since the audience never sees the distinction.

---

## Script

Each section names what appears on screen and what you say. The
timecodes are targets, not a fixed rhythm. Read the whole script
aloud once. Adjust the timecodes before you trust them.

### Act 1, cold open, on camera (0:00-0:40)

VISUAL: My chair empty, then me walking into frame, sitting, looking at the camera and starting to speak.

> An agent tried to buy a bottle of handwash today.
>
> It found the product, checked the price and stock.
>
> But... It never paid.
>
> An agent can help you choose groceries. It cannot buy them for you.
>
> Razorpay already runs agentic commerce today. Five brands. Zomato,
> Swiggy, Zepto, Vi, and BigBasket. Razorpay picked these five by
> hand. Razorpay can vouch for five names it already knows.
>
> Razorpay cannot vouch for a merchant it has never met. So that
> merchant stays closed to every agent.
>
> This layer lets Razorpay open a merchant to agents. It decides, on
> every transaction, whether to allow the agent, and it logs every
> decision it makes.
>
> I am Dharmin Nagar. I build around agentic AI and blockchain. I
> built this.
>
> Let me show you how it works.

_(cut to screen)_

### Act 2, the investigation, screen capture (0:40-4:07)

**Onboarding (0:40-1:10)**

VISUAL: upload `demo-merchant-a.csv`, policy form, untick
`personal-care` and `beverages` on screen, submit, token appears.

> A merchant signs up with a CSV file and four form fields. No
> approval committee reviews the request. No person waits on another
> person.
>
> This merchant sells staples, dairy, snacks, and household goods. Not
> personal care. Not beverages. The merchant set this rule. The
> system did not set a default rule here.
>
> One token. This token is the entire handoff to the agent.

**Buyer connect (1:10-1:22)**

VISUAL: `/buyer/stores`, already signed in as the buyer (sign-in is
not shown). Click Connect on the demo merchant. The token appears
once, with the connect-instructions copy visible under it, not
narrated here.

> The buyer connects from their own account, to a merchant they
> picked from a list.
>
> This token is the buyer's, with the buyer's own cap. Not the
> merchant's.

**Terminal, agent trace and the re-plan (1:22-2:42)**

VISUAL: MCP client connects with the buyer's token, calls
`list_products`, then `checkout` on the Lifebuoy Handwash line, tool
error comes back, agent's next call is a different, allowed product,
checkout succeeds.

> The agent connects with that token. This can be any MCP client, not
> only mine.
>
> The agent reads the catalog. It decides to buy handwash.
>
> _(let the block happen on screen. do not talk over it)_
>
> The gate returns `CATEGORY_NOT_ALLOWED`. The gate did not ask the
> merchant. The gate did not ask me. The gate already applied the
> rule.
>
> Watch the next step. The agent does not repeat the same request.
> The agent reads the reason code and re-plans.
>
> The agent picks an item the policy allows. This time, the order
> clears.

**Audit view (2:42-2:52)**

VISUAL: the two rows, blocked, then allowed, same session. Quick cut,
do not linger here.

> Every branch writes a row. The block writes a row. The allow writes
> a row. Not only the successful checkouts.

**Razorpay dashboard (2:52-3:17)**

VISUAL: Test Mode, Orders, the same order id on screen.

> This order id is not staged. Razorpay created this order through
> the real Orders API, at the moment the gate allowed the agent's
> second attempt.

**Metrics table, say the escapes out loud (3:17-4:07)**

VISUAL: `bun run eval:report`, full table on screen, let it sit long
enough to read.

> This test covers 261 scripted attempts across six threat classes.
> On the split shown today, the gate catches every attempt. This
> includes the benign sessions and the adversarial sessions.
>
> These tests are not written via a single model, but rather by multiple models, with just the concept of the policy, catalog, and the user agent tools. The models never saw the actual working code to ensure non-bias.
> The gate caught every attempt.
>
> That result is not the whole story. Here is the rest of it, transparently saying because no system is perfect.
>
> Zero benign sessions were blocked in this corpus and that does not
> prove zero false positives exist.
>
> The platform-wide spend ceiling has no test coverage yet.
>
> When a number in this report cannot support itself, the report
> states that directly. The report does not hide the gap.

_(cut back to camera)_

### Act 3, the reckoning, on camera (4:07-5:02)

> Razorpay already vouches for five merchants. Razorpay picked these
> five by hand.
>
> This project shows what it takes to vouch for the sixth merchant,
> and the six-thousandth merchant. The answer is not a longer trust
> list. The answer is a gate that decides on every transaction, and
> shows its work every time the gate is wrong or unsure.
>
> Outside India, other companies solved this problem already. Shopify
> shipped self-serve agent checkout in June 2026. Stripe shipped its
> own agentic commerce suite in December 2025.
>
> Nobody has shipped this on UPI rails, where every payment still
> assumes a human presses a button. This is the only claim this
> project makes. Not the first agent commerce system. The first
> vouching layer built for this rail.
>
> I asked Razorpay support about two headless payment paths. BharatQR
> is deprecated. Server to server needs PCI-DSS certification. Both
> constraints are real. An agent cannot authorize a UPI payment alone
> today. That is regulation. So a human approves the last step.
>
> The agent that tried to buy handwash earlier did not wait for a
> human for any step before that one. The gate already decided
> everything up to the payment, on its own.

_(end)_

---

## Word-count and pacing check

These are counted from the spoken lines in this file, not estimated.
The rate is 140 words per minute, a measured documentary pace.

| Act                      | Spoken words | Speech time    |
| ------------------------ | ------------ | -------------- |
| Act 1, cold open         | 130          | about 0:56     |
| Act 2, the investigation | 356          | about 2:33     |
| Act 3, the reckoning     | 196          | about 1:24     |
| **Total**                | **682**      | **about 4:52** |

**The ceiling is 5:00, so the margin for every pause in the video is
about 8 seconds combined.** That is the honest figure, and it is
tighter than the per-beat timecodes above imply. Those timecodes are
targets for where each beat starts. They are not a promise that the
whole thing fits.

Two consequences, both of which decide themselves during the
read-aloud pass rather than in the edit:

1. The deliberate silences must be short. The block landing on screen
   and the metrics table sitting on screen are worth two or three
   seconds each, not ten.
2. If the read runs long, Act 1 is the place to cut. It carries the
   hook, the Razorpay framing and now the introduction, and at 0:55 it
   is the act furthest over its own target. Act 3 is second. Do not
   cut the escapes in Act 2. DUK-22 names those as the one thing not
   to drop for time.

Read the whole script aloud with a stopwatch before the first real
take. If it comes in over 5:00, cut words. Do not speed up the read.
