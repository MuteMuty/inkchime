// Browsers can't autoplay, so someone who opens a song link sees a still drawing.
// The invite tells them it is a song and to press Play. Plain logic, so it can be
// unit-tested with `node --test`; the page decides when the visitor has acted.
import type { Song } from "./model.ts";

/**
 * Whether a page that opened with this song should invite the visitor to press Play.
 * `opened` is the song from the address (null for no hash or a broken one), and
 * `sharedHere` is true when this tab pressed Share: that is the author reloading
 * their own live link, who knows it is a song.
 */
export function invitesPlay(opened: Song | null, sharedHere: boolean): boolean {
  return !!opened && opened.strokes.length > 0 && !sharedHere;
}

/** Shown from the start when invited, until the visitor plays, draws, clears or opens another song. Never again in this tab. */
export class PlayInvite {
  private on: boolean;

  constructor(opened: Song | null, sharedHere: boolean) {
    this.on = invitesPlay(opened, sharedHere);
  }

  get showing(): boolean {
    return this.on;
  }

  /** The visitor has acted. Returns true if the invite was showing until now. */
  end(): boolean {
    const was = this.on;
    this.on = false;
    return was;
  }
}
