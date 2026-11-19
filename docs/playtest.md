# What the playtest checks

`tests/playtest.ts` drives a real browser at 1280 by 900 and 390 by 844 and checks:

- A drawn stroke is added.
- Pressing play schedules its notes at the right times, with pitch from height and gain from thickness.
- The first sound comes within about 100 ms of the press.
- Space, Ctrl or ⌘ Z and the Tab order work.
- With the keyboard alone (light and dark) the canvas takes focus with a visible ring, the arrows move a clamped cursor, Enter and N place notes in the current colour and size that are announced, undone, heard on Play, shared, followed by the live link and end the invite, and a click hides the cursor again.
- Share, then opening the link in a fresh page, gives the same strokes and the same note schedule, with an invite to press Play that Play, drawing or another song ends (and that a normal visit, a broken link, an empty-canvas link or the author's own reload never shows).
- Before Share the address bar is left alone, and after it every stroke, undo, tempo change and clear is followed, so a reload gives the same song, even one a few milliseconds after pen-up, undo, a placed note, letting go of the tempo slider or clear (with the idle write stalled), while a tempo drag writes once per idle moment rather than per input event, a reload right after letting go of a long tempo drag or a held arrow key (with real idle writes spending the budget) opens the tempo it was let go at while the drag stays within the budget, a tempo drag still waiting is written on `pagehide` and `visibilitychange`, holding Ctrl+Z through 150 strokes while the browser refuses address-bar writes undoes every one with no page errors and the address bar catches up afterwards, with no new history entry and no dropped frames while drawing.
- Broken links open an empty canvas.
- The like heart (against a mocked like API, never the live one) likes at once, survives a reload, unlikes with the stored receipt (also days later), works by keyboard with its label and `aria-pressed`, rolls back a 409 or 429 with a note, sets no cookies, and leaves the address bar, history, live link and play invite alone.
- It fits the dock without making it taller at 320, 390 and 1280 wide.
- Held sideways at 844 by 390 and 667 by 375, with the heart and without, the page doesn't scroll, every control is on screen and at least 44px, the canvas is at least 200px tall and still takes a line.
- Held sideways at 844 by 390, 667 by 375 and 568 by 320, every toast sits centred over the canvas and never on the dock.
- A 1024 by 499 window gets the side dock and a 1024 by 500 one keeps it below.
- The Brush slider is named by its visible label alone and described by its hint, and the bpm readout is not a live region, so each slider is read once.
- With the like API resting (204), down or slow, the heart never shows, drawing and playback don't wait and nothing errors.
- The page asks nothing but its own origin and the like API, so on localhost the analytics script is never fetched.
- The footer's Privacy link sits after "BrightLoop Lab", styled like it, on screen and clickable in light and dark at 1280 by 900, 390 by 844, 844 by 390 and 568 by 320.
- Under a made-up `*.brightloopapps.com` address (with the hub's built analytics script and PostHog both answered locally), drawing, a placed note, Share, more drawing and Share again send exactly `$pageview`, one `play_started` and one `play_finished` from `blank`, and opening the song link sends the same from `link`, with no request holding the song or its link, every address without `#` or `?`, the first line drawn before a slow script arrives, which loads only after the page has, and no cookies or storage of analytics' own.
- With Do Not Track, Global Privacy Control or on a workers.dev address the script isn't fetched and nothing is sent, and with it blocked Inkchime draws, plays and shares with no console error.
- Nothing overflows sideways.
- The console stays free of errors.
