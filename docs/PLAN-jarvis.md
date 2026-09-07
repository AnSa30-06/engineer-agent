# Improvement plan — what the "build your own Jarvis" trend actually teaches us

Written 2026-08-25 from 10+ Instagram/Facebook posts and one full frame-parse of a YouTube
build (`brain/ref/video-notes/2od7tPirPYE/NOTES.md`).

## What the corpus says

The viral script is the same nine steps everywhere: **give it a home** (an always-on machine)
· **install an agent harness** · connect tools · **persistent memory** · **skills for specific
jobs** · a voice · a schedule. The most-shared single line in the corpus is about the file
system — *"nobody talks about the part that makes Jarvis actually useful"*.

⭐ **We already have the part everyone else is faking.** Almost every build in the corpus is
n8n wiring or a chat wrapper. Ours runs a real headless coding agent that writes and runs
software, enforces permissions, and refuses to claim a test happened when it did not. That is
the moat, and none of this plan touches it.

⚠️ **What we are deliberately NOT copying**, because it is the demo rather than the idea:
the 3D knowledge-graph "galaxy" (we build software, we do not browse notes), Mac/OS control,
placing phone calls, and reading real Gmail. Each is a large new permission surface for a
product whose whole safety story is *he cannot leave the project folder*.

## The three gaps worth closing

### A. Capability — he forgets everything (the biggest real gap)

**Persistent memory is the one thing every version of this promises and ours does not have.**
Close the app and he loses the project, your preferences, and every decision you made. The
corpus is unanimous on this (step five in the nine-step script; *"an AI that never forgets
because it keeps daily logs"*).

- `memory.json` beside the config: past builds (goal, folder, outcome, when) and settled
  preferences (language, style, things you told him once).
- The interviewer receives it, so he can open with what he already knows and **stop re-asking
  what you have already answered**.
- Written at handoff and at completion. Bounded, so it cannot grow without limit.

### B. Functionality — you cannot interrupt him, and he listens when you are not talking

- **Wake word.** When idle he only acts on speech containing his name, so a room conversation
  does not start a build.
- **Barge-in.** Talking over him stops him mid-sentence, the way you would interrupt a person.
  Guarded against his own voice: the mic must beat his current playback amplitude by a margin,
  using the amplitude the mouth animation already measures.

### C. UI — the state HUD is the whole identity

Measured finding from the parse: strip the circular dial out of that JARVIS build and it is a
graph viewer with a voice. **The dial is what makes it read as Jarvis**, and ours is a grey
text pill.

- A circular reactor dial, top-right, ~120px, pure SVG + CSS.
- Five states, each distinct by **motion and shape as well as colour** so it survives
  colour-blindness: `IDLE` · `LISTENING` · `THINKING` · `SPEAKING` · `RINGING`.
- Live microphone level drives a ring while listening.
- A model chip, so which brain is running is visible.
- Must not cover the character, and must hold contrast over an arbitrary wallpaper.

⚠️ **Gemini was asked to do this design and could not** — the API key returns HTTP 429,
quota exhausted, on every available model. Designed instead from the full-resolution reference
frames, which is better grounding than a text brief anyway.

## Success criteria

1. `npm test` stays green and gains cases for memory and the wake word.
2. A second session can name what the first one built. Verified by running the app twice.
3. The HUD renders in all five states — verified by screenshot, not by reading the CSS.
4. The packaged `.exe` still builds working software end to end.
