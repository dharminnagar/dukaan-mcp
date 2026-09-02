# DUK-22, video script and shot list

Draft. Not committed. Time it aloud with a stopwatch before recording.
A script that feels like five minutes reads as seven.

Structure: an on-camera cold open, then a screen-capture investigation,
then an on-camera close. Documentary pacing. Short declarative lines.
Real pauses. No "hi, I am Dharmin, welcome to my project" opener. The
script states the problem like a finding. It does not pitch the
problem.

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
3. Terminal, the agent trace. Use a real MCP client, not a custom
   script. The client connects with the printed token. It lists
   products. It attempts checkout on `sku-a22`, Lifebuoy Handwash
   500ml, category `personal-care`. The gate returns the
   `CATEGORY_NOT_ALLOWED` tool error. The agent re-plans. It picks an
   allowed item. It checks out again. This checkout succeeds. Increase
   the terminal font size before you record. Your normal font size is
   not readable at 720p.
4. Audit view. The two rows from that session: the blocked
   `CATEGORY_NOT_ALLOWED` row, and the `ALLOWED` row with the order
   id.
5. Razorpay dashboard, Test Mode, Orders. The same `order_` id from
   step 3 and step 4, visible on screen, matched to a real
   API-created order.
6. Terminal, run `bun run eval:report` with no `--split` flag. This
   command prints the train-split report. Do not run
   `--split=holdout`. That run is reserved. Let the full table stay on
   screen.
7. On-camera, close. State the vouching thesis. Scope the claim to
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
> The world today has evoled to a point where an agent can help you buy groceries, but it cannot buy groceries for you. This world needs a guardrail, a vouching layer that decides on every transaction whether to let the agent buy, and shows its work every time it is wrong or unsure. That's how we achieve Agentic Commerce.
>
> Razorpay already runs agentic commerce today. Five brands. Zomato,
> Swiggy, Zepto, Vi, and BigBasket. Razorpay picked these five by
> hand. Razorpay can vouch for five names it already knows.
>
> Razorpay cannot vouch for a merchant it has never met. So that
> merchant stays closed to every agent.
>
> This layer lets Razorpay open a merchant to agents. It decides, on
> every transaction, whether to allow the agent, all while keeping track of every decision and logging every step.
>
> Let me show you how it works.

_(cut to screen)_

### Act 2, the investigation, screen capture (0:40-4:05)

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

**Terminal, agent trace and the re-plan (1:10-2:30)**

VISUAL: MCP client connects with the token, calls `list_products`,
then `checkout` on the Lifebuoy Handwash line, tool error comes back,
agent's next call is a different, allowed product, checkout succeeds.

> The buyer connects an agent. This can be any MCP client, not only
> mine.
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

**Audit view (2:30-2:50)**

VISUAL: the two rows, blocked, then allowed, same session.

> Every branch writes a row. The block writes a row. The allow writes
> a row. Not only the successful checkouts.

**Razorpay dashboard (2:50-3:15)**

VISUAL: Test Mode, Orders, the same order id on screen.

> This order id is not staged. Razorpay created this order through
> the real Orders API, at the moment the gate allowed the agent's
> second attempt.

**Metrics table, say the escapes out loud (3:15-4:05)**

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

### Act 3, the reckoning, on camera (4:05-5:00)

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
> I raised two support tickets. Both ask Razorpay for a payment path
> an agent can complete alone. Razorpay has not granted either ticket
> yet. So today, a human still approves the last step.
>
> The agent that tried to buy handwash earlier did not wait for a
> human for any step before that one. The gate already decided
> everything up to the payment, on its own.

_(end)_

---

## Word-count and pacing check

This count uses about 140 words per minute, a measured documentary
pace with pauses where marked.

- Act 1: about 115 words, roughly 50 seconds against a 40-second
  target. Trim during the read-aloud pass if the timing runs long.
  This act has the least room. DUK-22 wants this act near 45 seconds.
- Act 2: about 330 words across 3 minutes 25 seconds of screen time.
  This total includes two deliberate silences on screen, the block
  firing and the table sitting on screen. The word count is correctly
  lower than the available time. Let the footage hold the screen. Do
  not pad the voiceover to fill the time.
- Act 3: about 155 words, roughly 55 to 65 seconds.

Read the script aloud once, with a stopwatch running, before the
first real take.
