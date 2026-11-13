# Inkchime

**Draw lines, hear music.** Play it at **[inkchime.brightloopapps.com](https://inkchime.brightloopapps.com)**.

Draw on the canvas with a mouse, finger or pen. A playhead sweeps left to right, looping every 4 to 8 seconds, and each line sounds as the playhead crosses it.

| You draw | You hear |
|---|---|
| **Colour** | the instrument: Bell, Pluck, Pad or Tap, each synthesized live with Web Audio (oscillators, filters, noise), no samples |
| **Height** | the pitch, snapped to a pentatonic scale over three octaves (C3 to A5), so anything you draw sounds musical |
| **Thickness** | the volume |
| **Left to right** | the time: the loop is 32 columns across, and a note starts in the column you drew it in |

A vertical scribble is a chord: a column plays at most three notes (the lowest, middle and highest the line touches). **Share** copies a link that holds the whole song (strokes, colours, sizes and tempo) in the URL hash. From then on the address bar follows the song as you keep drawing, undoing, clearing or changing the tempo, so a reload always opens what is on screen. Someone who opens a song link sees "Someone sent you a song. Press play to hear it." (browsers can't autoplay) until they press Play, draw, or open another song. Nothing is stored on a server, and there is no tracking.

Keys: **Space** plays and pauses (on a focused button it presses that button instead), **Ctrl or ⌘ Z** undoes. The canvas and every control are reachable with Tab.

You can also draw with the keyboard alone. **Tab** to the canvas (the first stop on the page) and a cursor appears on the grid of 32 columns by 15 rows. The **arrow keys** move it, stopping at the edges, and **Enter** or **N** places a short note in that cell with the current colour and brush size. A placed note is an ordinary stroke: Undo, Share and the address bar treat it like a line you drew, and opening a song link and placing a note ends the invite just like drawing. Screen readers hear the canvas described with these keys, and a polite announcement says where the cursor is ("Column 5, pitch E4") and what was placed ("Bell, column 5, pitch E4"). Pick the colour and brush with Tab and the arrow keys as usual. Clicking or touching the canvas hides the cursor until the next key.

## How it's built

| Part | What it does |
|---|---|
| `src/core/` | Pure TypeScript with no browser APIs, all unit-tested: `pitch.ts` (height to scale degree, thickness to gain), `stroke.ts` (quantise and simplify a stroke), `notes.ts` (strokes to notes), `share.ts` (the link format), `livelink.ts` (keeping the address bar in step after Share), `invite.ts` (when a song link invites Play), `keypen.ts` (the keyboard cursor and the note it places), `scheduler.ts` (the lookahead logic), `history.ts` (undo). |
| `src/audio/` | `voices.ts` (the four instruments), `engine.ts` (the AudioContext, resumed on the first gesture), `player.ts` (a 25 ms timer that schedules the next 120 ms of notes at exact audio-clock times, so timer jitter never reaches the sound). |
| `src/ui/stage.ts` | Plain Canvas 2D in three layers: committed strokes (redrawn only when the song changes), the stroke being drawn (one small curve added per pointer event), and the rings that bloom as notes sound. The playhead is an element moved with a transform. |
| `index.html`, `src/style.css` | One page, light and dark from the system. The voice colours are defined once in CSS and the canvas reads them back. |

The built page is about 9 KB of JavaScript gzipped, no dependencies at runtime, no web fonts.

### The share format

`#v1.` and then URL-safe base64 of: a version byte, the tempo, and for each stroke its colour and size, then its points as a start position plus zigzag-varint deltas. Strokes are quantised to a 1024 by 1024 grid and simplified when you lift the pen, so the song in memory is exactly the song a link rebuilds. A straight line costs about 20 characters and a long hand-drawn wave about 150. A link that is malformed, truncated or out of range opens an empty canvas and never throws.

A song holds at most 400 strokes (drawing stops there, with a note), and a link payload is at most 120,000 characters; both limits live in `core/model.ts` and are used by drawing, encoder and decoder. Share decodes the link it is about to copy and only claims success if it opens to the same song. If the payload is too long it simplifies the points further, but only as far as the notes stay identical; otherwise it says the song is too big to share.

After Share, the address bar follows the song. Each edit queues one rewrite of the hash for the next idle moment (a burst of edits is written once), with `history.replaceState`, so it never adds a Back step and never runs in the middle of a stroke. Lifting the pen writes it straight away rather than at idle, because a reload starts from the address it was given: a reload a few milliseconds after pen-up still keeps that stroke. Anything else still waiting (an undo or a tempo change) is written as soon as the tab is hidden (`visibilitychange`, `pagehide`), so a phone that drops a background tab and reopens it gets the latest song. It goes through the same checks as Share: if the song stops fitting, the address bar keeps the last link that did, and a note says so. Clearing gives a link to an empty canvas at the same tempo. The history entry Share wrote is marked, so a reload of that tab keeps following; the same link opened anywhere else behaves as before until its own Share.

## Run it

```sh
# needs Node 22.18 or newer (the unit tests run TypeScript directly)
npm install
npm run dev                         # local dev server
npm test                            # unit tests (node --test)
npm run build                       # typecheck, then build to dist/
npm run deploy                      # build and deploy to Cloudflare
```

The playtest drives a real browser. Headless audio can't be heard, so the page exposes a small read-only hook, `window.__inkchime`, listing every note handed to Web Audio with its exact start time and the schedule the strokes should produce.

```sh
npx vite preview --port 4173 --strictPort &
node tests/playtest.mjs http://localhost:4173
# PLAYTEST_BROWSER  Chromium-based browser executable (default: Brave; falls back to Playwright's Chromium)
# PLAYTEST_OUT      screenshot folder (default: ./playtest-out)
```

It checks, at 1280 by 900 and 390 by 844: a drawn stroke is added; pressing play schedules its notes at the right times, with pitch from height and gain from thickness; the first sound comes within about 100 ms of the press; Space, Ctrl or ⌘ Z and the Tab order work; with the keyboard alone (light and dark) the canvas takes focus with a visible ring, the arrows move a clamped cursor, Enter and N place notes in the current colour and size that are announced, undone, heard on Play, shared, followed by the live link and end the invite, and a click hides the cursor again; Share, then opening the link in a fresh page, gives the same strokes and the same note schedule, with an invite to press Play that Play, drawing or another song ends (and that a normal visit, a broken link, an empty-canvas link or the author's own reload never shows); before Share the address bar is left alone, and after it every stroke, undo, tempo change and clear is followed, so a reload gives the same song, even one a few milliseconds after pen-up, with no new history entry and no dropped frames while drawing; broken links open an empty canvas; nothing overflows sideways; and the console stays free of errors.

Made by [Erik Pahor](https://github.com/MuteMuty) at [BrightLoop Lab](https://lab.brightloopapps.com).
