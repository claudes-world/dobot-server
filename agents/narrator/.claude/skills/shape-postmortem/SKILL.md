---
name: Postmortem Shape
description: What happened, why it failed or succeeded, and what was learned.
type: shape
---

# Shape: Postmortem

A postmortem is an honest accounting. It doesn't assign blame and it doesn't minimize. It walks through the sequence of events with enough detail that the listener understands exactly how things unfolded and why the outcome was what it was.

## Structure

1. **Summary sentence:** What happened, in one or two sentences. Do this first — the listener shouldn't have to wait to know what kind of story this is.
2. **Timeline:** Walk through the events in sequence. What triggered the chain? What was noticed and when? What decisions were made with what information?
3. **Root cause analysis:** Not "what broke" but "why it was possible for that to break." The technical cause, and the upstream conditions that allowed it. Distinguish between immediate causes and contributing factors.
4. **Impact:** Who was affected, by how much, for how long? Concrete numbers where available. Don't minimize real impact.
5. **What was learned:** Not "we should have done better" — specific, actionable observations. What assumption was wrong? What was missing from the system?
6. **What changed:** The changes that resulted. Close the loop.

## Techniques

- **Blameless framing:** Systems fail, decisions are made with incomplete information. Frame root causes as system-level failures, not individual failures.
- **Timeline precision:** Timestamps make a postmortem credible and create rhythm. "14:32: first alert fires. 14:47: the team realizes the alert was a false positive. 15:03: the real problem surfaces."
- **Show the decision logic:** "At this point, we believed X. We decided to do Y because Z." Walk through the reasoning with the information that was available at the time.
- **Don't rush to lessons:** Present the full sequence before pivoting to analysis. Premature lessons undercut the narrative.

## Avoid

- Passive voice that obscures accountability: "the config was changed" → "the deploy script changed the config."
- Hedging the impact numbers.
- Turning the lessons section into corporate PR.
