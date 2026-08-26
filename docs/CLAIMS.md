# What this project can and cannot claim

Working notes for DUK-21 (README), DUK-22 (video) and DUK-23 (form). Not the
pitch. The pitch is Dharmin's voice; this is the factual floor under it, so no
sentence in the submission has to be walked back under questioning.

Every claim below is either verified in this repo or marked as unverified.
Where a claim is tempting but wrong, the correct weaker wording is given. Use
the weaker wording. A judge who probes a careful claim and finds it holds is
worth more than a bold claim that collapses.

---

## Claims that hold

**Real money movement, not a mock.** `POST /v1/orders` against Razorpay
test mode returns real `order_` ids. `bun run smoke:razorpay` is the narrowest
probe of it and refuses to run unless the key starts with `rzp_test_`, because
the base URL is identical for test and live and the key prefix is the only
guard.

**A policy decision on every agent money action.** Five ordered checks return
`allow`, `block` or `escalate` with a reason code. The gate is a pure function
that never imports Razorpay, which is why the eval can drive it directly with
no network and no spend.

**The tightest of three spend limits binds.** Buyer's cap, merchant's exposure
limit, platform ceiling. Verified live: with a ₹500 buyer cap against a ₹5,000
merchant cap, a real MCP checkout blocked with `bound_by: "buyer"` and reported
all three figures. The merchant's looser cap did not matter.

**Every money action is reconstructible from the audit log alone.** True as of
`53880e7`, and it was not before: the allow branch used to audit
`order_id: null` while the caller generated an id it never wrote back. Both the
allow and escalate branches now mint through the gate, so the audit row and the
order row share one id.

**The spend cap is not beatable by issuing checkouts in parallel.** Three
concurrent checkouts against a cap only one of them fits used to all pass. Fixed
with a Postgres advisory lock enclosing `decide()` and the insert. The test uses
`floor(cap / amount) == 1` deliberately, so luck cannot save a broken build.

**Duplicate line items can neither oversell stock nor underpay.** Price is
checked per line item, because the same `item_id` may appear twice with
different asserted prices. Stock is checked per aggregate quantity, because two
line items naming one product each pass an independent test while their sum
oversells it. Both directions have tests.

**Part of the corpus was authored by a model that never saw the gate.** The
model returned 67 transcripts; 41 survived validation against the real catalog
and are what the committed fixture holds. Quote both numbers. A 39% rejection
rate is a point in the method's favour, not an embarrassment: generated
transcripts were checked rather than trusted, and most rejections were sessions
the model labelled benign while asserting a total above the published approval
threshold, which the fixture would otherwise have counted as a false positive
the gate never made.

The generating prompt is committed at `fixtures/eval/llm-generation-prompt.md`
and a test asserts it contains none of ten gate identifiers, so a later helpful
addition of context turns the suite red rather than making the claim quietly
false. The gate caught all 9 independently-authored attacks in the train split.

**Every number reproduces offline from a clone with no API key.** Generation is
split from scoring: one command makes the live call and writes a committed
fixture, the other reads it and never calls out.

**The column mapper cannot see product values beyond three sample rows, and
cannot return one.** `buildMappingPrompt(header, sampleRows)` cannot be handed
the file, so no caller can widen its view. On the return path, any proposed name
that is not an exact member of the real header rejects the whole response, so
neither a hallucinated column nor a value dressed as a column name gets through.
Both properties are structural, not conventional.

---

## Claims that do not hold, and what to say instead

**Do not say precision and recall.** Say _rule coverage over a declared threat
model_. Precision and recall over a population the rule author also wrote
measures implementation correctness against a spec, not detection against an
adversary. The report already refuses those words in its own text; the README
must not reintroduce them.

**Do not say the buyer sets their own cap.** In this build the merchant mints
agent tokens, so the merchant sets the buyer's cap too. Say: _the mechanism
enforces whichever limit is tightest, and moving the buyer's cap to the buyer is
a change of caller, not a change to the gate._ That is true, checkable, and
still answers the incentive objection.

**Do not say the buyer's cap is immutable.** It is not immutable at rest; one
`UPDATE` from anyone with database access changes it. Migration 0002 argues
against a trigger on the grounds that a buyer-side deployment wants its own
write path, which is fair. So say: _no code path raises it after mint, and a
test over the source enforces that._ Enforced in CI, not by the database.

**Do not claim a false-positive rate.** There isn't one. Zero benign sessions
were blocked across 164 benign checkout steps, 82 of them deliberately placed at
a policy limit, so recovery has no denominator. The report prints
`NOT MEASURABLE` with the reason and refuses to assume 0%. Leave it saying that.
The absence of a measurable false-positive rate is a stronger disclosure than a
flattering one.

**Do not headline the interrupted-intent total.** The total is ₹2,60,231 and a
single session is 85% of it. The median is ₹1,299. Quote the median as
representative and the total as an upper bound, which is what the report does.
Net is the summed value of sessions that did not recover, not the total scaled
by the recovery rate: recovered and unrecovered sessions differ in average value
by roughly seven times, and rate-scaling overstated it by several hundred
percent before it was fixed.

**Do not overstate how far the circularity broke.** Three limits, all worth
stating: the independent model produced no attack shape the hand batch lacked;
it never once asserted a quantity beyond available stock, so `merchant_misclaim`
remains entirely self-authored; and every generated transcript is single-step, so
its `budget_split` and `threshold_straddling` cases are single oversized orders
rather than the accumulate-under-the-radar evasion those names describe. They
exercise the right rule; the class labels overstate what they test.

**Do not claim the generation is reproducible.** `stealth/ox-alpha`, which
authored the independent batch, has been withdrawn and returns 404. The manifest
still names it deliberately, because that field records what actually produced
those transcripts and is provenance rather than configuration. So the batch can
never be regenerated by anyone, while every number still reproduces offline from
the committed fixture. That is worth saying out loud: it is the reason the
fixture is committed, and an inline API call would have destroyed the eval.

**Do not imply the dashboard is access-controlled.** It is keyed on a merchant
id in the path with no session. The agent token is the agent's credential and
must not double as a merchant login. Documented as an accepted gap in the module
doc; it needs one honest README line too.

**Do not claim eval coverage for the platform ceiling.** It is inert inside the
eval, because the only place the harness builds gate dependencies is frozen. That
is exactly why the numbers did not move when three-party limits landed, so it is
a feature of the change rather than a hole in it, but the ceiling itself has no
eval coverage.

**Say whether the held-out split was run, and when.** It is scored exactly once
and has not been run yet. Whatever it reports is what gets published. If it comes
back worse than the train figures, publish it anyway: that gap is the most
credible thing in the report.

---

## What the numbers mean

| Figure                          | What it measures                                                    | What it does not                                                             |
| ------------------------------- | ------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| Rule coverage, N of M per rule  | Whether the gate implements its stated policy                       | Robustness against an attacker outside the declared threat model             |
| Blocked benign GMV, ₹0.00       | That the gate declined the near-boundary opportunities it was given | That no legitimate sale can ever be blocked                                  |
| Interrupted intent, 12 sessions | Sales the policy stopped, right or wrong                            | Gate error. The gate is correct about changed state                          |
| Recovery, 9 of 12               | Interrupted sessions that completed a substitute purchase           | A false-positive recovery rate; there are no false positives to recover from |
| Origin column                   | Which findings came from a genuinely different author               | That the independent author was thorough                                     |

Merchant GMV, merchant margin and Razorpay MDR are three different numbers. The
report's figures are none of them, and the totals come from an invented catalog.

---

## One framing question still open

Three of the five gate checks are configured by the merchant they constrain.
Three-party limits fixed that for the spend cap. The category allowlist and the
approval threshold are still the merchant's alone.

The defensible framing is that the platform owns the policy shape and the
merchant configures within it, with buyer-owned policy as declared future work.
The indefensible one is implying the buyer already controls all five. Pick the
first, say it plainly, and the remaining gap reads as roadmap rather than as
something a judge caught.
