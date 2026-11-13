import { test } from "node:test";
import assert from "node:assert/strict";
import { PlayInvite, invitesPlay } from "../../src/core/invite.ts";
import { songFromHash, songToHash } from "../../src/core/share.ts";
import type { Song, Stroke } from "../../src/core/model.ts";

const line = (y: number): Stroke => ({ color: 1, size: 4, pts: [10, y, 600, y] });
const song = (...strokes: Stroke[]): Song => ({ bpm: 90, strokes });

// --- invitesPlay ------------------------------------------------------------------

test("invitesPlay: a song link opened in a tab that never shared it invites Play", () => {
  assert.equal(invitesPlay(song(line(100)), false), true);
  // The same, coming through a real link.
  assert.equal(invitesPlay(songFromHash(songToHash(song(line(100), line(700)))), false), true);
});

test("invitesPlay: no invite for a normal visit, a broken link or an empty song", () => {
  assert.equal(invitesPlay(null, false), false, "no hash, or a broken or truncated one");
  assert.equal(invitesPlay(songFromHash("#v1.AAAA"), false), false);
  assert.equal(invitesPlay(song(), false), false, "a link to an empty canvas (after Clear) has nothing to play");
});

test("invitesPlay: no invite when this tab shared the song (the author reloading their own live link)", () => {
  assert.equal(invitesPlay(song(line(100)), true), false);
});

// --- PlayInvite --------------------------------------------------------------------

test("PlayInvite: shows from the start when invited", () => {
  assert.equal(new PlayInvite(song(line(100)), false).showing, true);
  assert.equal(new PlayInvite(null, false).showing, false);
  assert.equal(new PlayInvite(song(line(100)), true).showing, false);
});

test("PlayInvite: once ended it never comes back in this tab", () => {
  const invite = new PlayInvite(song(line(100)), false);
  assert.equal(invite.end(), true, "ending a showing invite reports a change");
  assert.equal(invite.showing, false);
  assert.equal(invite.end(), false, "ending it again changes nothing");
  assert.equal(invite.showing, false);
});

test("PlayInvite: ending one that never showed changes nothing", () => {
  const invite = new PlayInvite(null, false);
  assert.equal(invite.end(), false);
  assert.equal(invite.showing, false);
});
