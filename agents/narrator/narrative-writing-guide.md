# Narrative Writing Guide — Rewriting Brief for @narrator_dobot

**Source:** Provided by Liam from a Claude Chat session on 2026-04-14 (msgs 6370-6373). This brief was produced by a prior Claude session that successfully rewrote the Inbox technical docs into enjoyable narrative prose.

**Purpose:** Canonical writing guide for the narrator agent. Referenced by the narrator's output style.

---

## The core problem with most technical prose

Technical writing defaults to a "declarative flat" mode: "X is Y. It does Z. That means W." Every sentence is a fact. Every paragraph is a list of facts. The reader's brain has nothing to latch onto — no stakes, no tension, no voice, no surprise. You can read three paragraphs and retain nothing because nothing was ever at risk.

Audio makes this worse. A listener can't skim, can't re-read, can't glance ahead. If the prose doesn't pull them forward sentence by sentence, they drift. Your job as the rewriter is to make every sentence slightly *want* the next one.

## The 13 techniques (ordered by importance)

### 1. Lead with tension, resolve with the thesis
Don't open with "X is a system that does Y." Open with a problem, a failure, a wrong answer, or a question — then reveal the subject as the resolution.

- Flat: "Inbox is a durable messaging system for agents."
- Better: "Most agent systems pick the wrong primitive. They start with orchestration diagrams. Hidden queues. A dispatcher that knows too much. A workflow engine wearing a protocol costume… Inbox starts somewhere else, with a question that sounds almost too simple: what if agents had inboxes?"

The second version makes the reader curious before the subject is named. That curiosity is the engine. You'll need it on every major transition.

### 2. Vary sentence length aggressively
Flat prose settles into medium-length sentences, all roughly the same rhythm. This is death for audio. Good prose pulses: long, long, short. Long, short, short, long. The short sentences land. The long ones carry you.

Watch for: every sentence being 12-20 words. That's the danger zone. Break it up. Add a three-word sentence. Add a fragment. Let the rhythm breathe.

- Flat: "The design got serious when the edge cases started multiplying. Inbox hardened not through one big leap, but through a sequence of small, stubborn design decisions."
- Better: "The core model is clean. The edge cases are where design dies."

Two short sentences. One contrast. The reader is now leaning forward.

### 3. Use specific scenes instead of abstract principles
Abstract principles are forgettable. Concrete scenes are memorable. Whenever the source says "X must not happen," find a way to stage X happening (or almost happening) with named characters doing specific things.

- Flat: "A new recipient added later must not gain retroactive access to earlier messages."
- Better: "Alice sends msg1 to Bob. Alice replies to msg1, sending the reply to Bob AND Carol. Carol now sees the reply. Does Carol see msg1?"

Then answer the question. The scene does the work the abstract rule couldn't. The reader will remember Carol a week later.

**This is the single biggest upgrade you can make to a technical doc.** Wherever you see an invariant stated abstractly, ask: "can I show this happening to a named character?" If yes, do it.

### 4. Give the narrator opinions
Flat prose is neutral. It reports. It doesn't judge. This is boring because the reader has no one to agree or disagree with.

Let the narrator have a voice. Let them call things "miserable," "absurd," "terrible," "the original sin of team-chat systems." Let them say "we're proudest of this part" and "this was the worst mistake we almost made."

- Flat: "The CLI uses message IDs instead of delivery IDs for user-facing commands."
- Better: "The CLI wanted to talk in deliveries too, at first. We even had the flags: `inbox read dly_01H…`. It worked. It was principled. It was also miserable."

That last sentence — "It was also miserable" — is the whole trick. The narrator has an opinion. The reader now trusts them more, not less, because opinionated narrators are easier to follow than neutral ones.

**Important caveat:** opinions must feel earned, not performative. The narrator should be opinionated about specific technical choices, not about themselves. Never "we built this amazing thing"; always "this design was miserable / this idea was a trap / this sentence is doing ten fewer footguns of work."

### 5. Name the near-misses and the things you rejected
Every design story has "things we almost did." These are gold. They show restraint, taste, and the fact that the final design was chosen, not just discovered.

Look for moments in the source where the author says "we considered X but didn't" or "we rejected Y" — even in passing. Blow them up into small callout moments. A rejected design gets the reader to trust the kept designs.

Pattern to look for: "We also considered…" / "One temptation was…" / "This was considered but…"

Whenever you find one, ask: what did it almost trap us into, and what principle did rejecting it lock in? Write that as a small story, not a parenthetical.

### 6. Use structural shape variety
If every section of the document looks identical — same headers, same paragraph shapes, same length — the reader's brain tunes out by the third one. You're showing them a template, not a story.

Deliberately vary the shape:
- Some sections are **machine-gun**: short paragraphs, rapid facts
- Some are **reflective**: one long thought, a pull quote, a pause
- Some are **scenario-driven**: a named example runs through the whole section
- Some are **list-driven**: a punchy enumeration with minimal prose
- Some are **code-forward**: let a code block or terminal example carry the point

The reader's attention should reset on every section transition. Variety is how you do that.

For a 10-section document, try to have at least 4 distinct section shapes. No two adjacent sections should feel the same.

### 7. Write pull quotes that actually pull
A pull quote isn't decoration. It's a moment where the narrative stops and says *remember this one*. Use it sparingly — maybe once every two or three sections — and only on sentences that would survive being stripped of context.

Good pull quotes are:
- Short (one sentence, rarely two)
- Complete in themselves (don't require the paragraph above to make sense)
- Slightly provocative or surprising
- Memorable as a phrase you could quote at someone later

- Weak: "Inbox preserves logical recipient intent and actual expanded deliveries."
- Strong: "The message is a fact. Your inbox state is an opinion about that fact."

If a pull quote doesn't pass the "would I actually quote this to someone" test, it shouldn't be a pull quote. Make it a regular sentence and find a better one.

### 8. Close loops the reader didn't know were open
One of the most satisfying narrative techniques is introducing something early that seems minor, then calling back to it later in a way that reveals it was load-bearing.

In the Inbox rewrite, early sections mentioned the email mental model casually. Later sections explicitly paid it off: "this is why the CLI feels like email instead of a database client." The reader thinks "oh, that was planted earlier." That moment of recognition is a hit of satisfaction.

Look for opportunities to plant small details early and pay them off later. Even better: set up an apparent contradiction early and resolve it later. ("The protocol is delivery-centric. The CLI is message-centric. Wait — how?")

### 9. Transitions should accelerate, not summarize
Flat writing ends sections by summarizing what was just said: "As we've seen, X leads to Y and Z." This is deadly for momentum. The reader has to re-process what they just read.

Better: end sections by pointing forward. The last sentence of a section should create gravity toward the next one.

- Flat closer: "These rules gave the design its internal consistency."
- Better closer: "Which brings us to the most unusual part of the design."

The reader doesn't want a recap. They want to know what's next. Give them a pull, not a push.

### 10. Let concrete examples carry abstract claims
Whenever you make a claim that's hard to grasp, immediately follow it with a specific instance. Not a hypothetical ("imagine if…"), but a definite scene with real details.

Pattern: **abstract claim → "Here's what that means:" → concrete example → return to abstract implications.**

This is especially important for audio, because listeners can't pause and think. The concrete example gives their brain something to hold while the abstraction settles.

### 11. Delete meta-commentary about the document itself
Flat writing is full of "in this section we will discuss" / "as mentioned earlier" / "it's worth noting that" / "to summarize." All of this is overhead that says nothing. Strip it ruthlessly.

The reader knows they're reading. The listener knows they're listening. You don't need to narrate the act of reading. Just say the thing.

- Before: "It's worth noting that one of the key design principles that emerged from our discussions was that conversations should be treated as lineage rather than as access control."
- After: "Conversation is lineage, not access control."

Same meaning. Ten words instead of thirty. And the shorter version is more memorable, not less, because it doesn't bury the point.

### 12. When in doubt, write for the ear
Read every paragraph out loud. If you stumble, the reader will too. If it sounds boring, it is boring. If a sentence has three prepositional phrases stacked on top of each other, your tongue will trip and so will the listener's attention.

Audio-friendly prose tends to:
- Avoid long noun phrases ("the delivery-centric recipient-local state mutation layer")
- Prefer active verbs to passive constructions
- Use contractions ("it's" not "it is," "don't" not "do not") in narrative passages
- Keep parenthetical asides short or cut them entirely
- Let sentences breathe between hard concepts

This isn't dumbing down. It's respecting the medium.

---

## The rewriting workflow

1. **Read the source once**, all the way through, without touching it. Get the full arc in your head.
2. **Identify the 3-5 most interesting moments.** The places where the source accidentally has tension, surprise, or stakes — even if it's buried. These become your section anchors.
3. **Find the rejected designs and near-misses.** These are usually hiding in throwaway phrases. Promote them.
4. **Find the abstract principles** and look for scenes that could carry them. Every "X must not happen" should become a story if possible.
5. **Draft the opening.** The first 200 words determine whether anyone keeps reading. Spend disproportionate effort here. Open with tension, resolve with the thesis.
6. **Draft each section with a specific shape in mind** — decide in advance whether it's reflective, machine-gun, scenario-driven, list-driven, etc. Don't let them default to the same shape.
7. **Read the whole thing out loud.** Mark every place you stumbled. Rewrite those sentences.
8. **Hunt meta-commentary.** Every "as we've seen" / "it's worth noting" / "in this section" gets deleted unless it's doing real work.
9. **Check the pull quotes.** Can they stand alone? If not, cut them or find better ones.
10. **Check section transitions.** Each one should pull forward, not recap backward.

---

## Traps to avoid

**Don't try to be clever on every sentence.** Cleverness is expensive attention. Save it for moments that earn it — section openings, closings, pull quotes, rejected-design callouts. The connective tissue between those should be clear, direct, and slightly plain. If every sentence is trying to sparkle, none of them do.

**Don't lose the source's technical accuracy.** Enjoyable prose is not a license to fudge details. If the source says "one canonical message, one delivery per recipient," the rewrite has to preserve that precision even while making it vivid. Check every technical claim against the source.

**Don't add content that wasn't in the source.** The job is to repackage, not to invent. If the source doesn't mention something, the rewrite shouldn't either — even if it would make a better story. Ask what's there, not what would be there.

**Don't sand off the edges.** If the source has a strong opinion or a sharp claim, keep it sharp. The rewriter's job is to amplify the voice that's already there, not to make it more diplomatic. Hedging kills narrative momentum faster than anything else.

**Watch for the "blog post voice" trap.** There's a particular register of tech writing that tries to sound conversational but ends up sounding like a LinkedIn post — lots of rhetorical questions, lots of "let me tell you about," lots of "here's the thing." This is not the same as good narrative prose. Good narrative prose earns its casualness through specificity and rhythm, not through conversational tics.

---

## The one-sentence version

> Make the reader (or listener) slightly want the next sentence, every sentence, and trust the narrator has taste.

That's it. Everything above is just techniques for doing that on a particular document.
