/**
 * Breaking a reply into speakable pieces.
 *
 * This started life as an audio optimisation — the first piece can start
 * playing while the rest are still being synthesised. It became load-bearing
 * for the CAPTION too: the bubble shows the piece being spoken, which is how a
 * long reply is displayed in full instead of clipped. So a piece that gets
 * dropped here is text the user never hears AND never reads, which is why this
 * lives in its own file with a test rather than inline in main.js.
 */

/** @returns {string[]} the pieces, in order. A short line stays whole. */
function splitForSpeech(line, max = 160) {
  const parts = line.match(/[^.!?]+[.!?]*\s*/g) || [line];
  const out = [];
  for (const p of parts) {
    const piece = p.trim();
    if (!piece) continue;
    const last = out[out.length - 1];
    // merge short fragments so he does not sound chopped up
    if (last && (last.length < 45 || last.length + piece.length <= max)) out[out.length - 1] = `${last} ${piece}`;
    else out.push(piece);
  }
  return out.length ? out : [line];
}

module.exports = { splitForSpeech };
