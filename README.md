# Inkchime

**Draw lines, hear music.** Play it at **[inkchime.brightloopapps.com](https://inkchime.brightloopapps.com)**.

Draw on the canvas with a mouse, finger or pen. A playhead sweeps left to right, looping every 4 to 8 seconds, and each line sounds as the playhead crosses it.

| You draw | You hear |
|---|---|
| **Colour** | the instrument: Bell, Pluck, Pad or Tap, each synthesized live with Web Audio (oscillators, filters, noise), no samples |
| **Height** | the pitch, snapped to a pentatonic scale over three octaves (C3 to A5), so anything you draw sounds musical |
| **Thickness** | the volume |
| **Left to right** | the time: the loop is 32 columns across, and a note starts in the column you drew it in |

A vertical scribble is a chord: a column plays at most three notes (the lowest, middle and highest the line touches). **Share** copies a link that holds the whole song (strokes, colours, sizes and tempo) in the URL hash. Nothing is stored on a server, and there is no tracking.

Keys: **Space** plays and pauses (on a focused button it presses that button instead), **Ctrl or ⌘ Z** undoes. Every control is reachable with Tab.

## How it's built

| Part | What it does |
|---|---|
| `src/core/` | Pure TypeScript with no browser APIs, all unit-tested: `pitch.ts` (height to scale degree, thickness to gain), `stroke.ts` (quantise and simplify a stroke), `notes.ts` (strokes to notes), `share.ts` (the link format), `scheduler.ts` (the lookahead logic), `history.ts` (undo). |
| `src/audio/` | `voices.ts` (the four instruments), `engine.ts` (the AudioContext, resumed on the first gesture), `player.ts` (a 25 ms timer that schedules the next 120 ms of notes at exact audio-clock times, so timer jitter never reaches the sound). |
| `src/ui/stage.ts` | Plain Canvas 2D in three layers: committed strokes (redrawn only when the song changes), the stroke being drawn (one small curve added per pointer event), and the rings that bloom as notes sound. The playhead is an element moved with a transform. |
| `index.html`, `src/style.css` | One page, light and dark from the system. The voice colours are defined once in CSS and the canvas reads them back. |

The built page is about 8 KB of JavaScript gzipped, no dependencies at runtime, no web fonts.

### The share format

`#v1.` and then URL-safe base64 of: a version byte, the tempo, and for each stroke its colour and size, then its points as a start position plus zigzag-varint deltas. Strokes are quantised to a 1024 by 1024 grid and simplified when you lift the pen, so the song in memory is exactly the song a link rebuilds. A straight line costs about 20 characters and a long hand-drawn wave about 150. A link that is malformed, truncated or out of range opens an empty canvas and never throws.

A song holds at most 400 strokes (drawing stops there, with a note), and a link payload is at most 120,000 characters; both limits live in `core/model.ts` and are used by drawing, encoder and decoder. Share decodes the link it is about to copy and only claims success if it opens to the same song. If the payload is too long it simplifies the points further, but only as far as the notes stay identical; otherwise it says the song is too big to share.

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

It checks, at 1280 by 900 and 390 by 844: a drawn stroke is added; pressing play schedules its notes at the right times, with pitch from height and gain from thickness; the first sound comes within about 100 ms of the press; Space, Ctrl or ⌘ Z and the Tab order work; Share, then opening the link in a fresh page, gives the same strokes and the same note schedule; broken links open an empty canvas; nothing overflows sideways; and the console stays free of errors.

Made by [Erik Pahor](https://github.com/MuteMuty) at [BrightLoop Lab](https://lab.brightloopapps.com).
