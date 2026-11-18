// Inkchime's usage events: the only ones it may send (lab SAFETY.md, "Usage events", lab#71), following
// the lab-wide convention: `$pageview`, then `play_started` on the first stroke or note placed with the
// keys, and `play_finished` when Share hands out a link, each at most once per page load. The one
// property says whether the page opened on an empty canvas or a song link. Nothing a visitor drew is
// ever sent: no strokes, colours, pitches, tempo, counts or the song link itself.
// Adding an event or value here is a normal commit; anything new in kind needs Erik.
import type { AllowList, Props } from "./analytics.ts";
import type { Song } from "./core/model.ts";

export const PROJECT = "inkchime";

/** The page opened on an empty canvas (no link, a broken one or an empty song), or on a song link. */
export type From = "blank" | "link";
const FROM: From[] = ["blank", "link"];

export const EVENTS = {
  $pageview: {},
  play_started: { from: FROM },
  play_finished: { from: FROM },
} satisfies AllowList;

/** `opened` is the song from the address when the page loaded (null for no hash or a broken one). */
export const fromOf = (opened: Song | null): From => (opened && opened.strokes.length > 0 ? "link" : "blank");

/** play_started and play_finished, each sent once per page load. `send` may throw. */
export function playEvents(send: (name: string, props: Props) => void, from: From) {
  const sent = new Set<string>();
  const once = (name: string) => {
    if (sent.has(name)) return;
    sent.add(name);
    try { send(name, { from }); } catch {}
  };
  return {
    /** The first stroke drawn or note placed with the keys. */
    started: () => once("play_started"),
    /** Share handed out a link. */
    finished: () => once("play_finished"),
  };
}
