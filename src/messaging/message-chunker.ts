/**
 * Shared message chunking policy for all outbound DingTalk text surfaces.
 *
 * DingTalk rejects (or silently fails to render) long payloads differently per
 * surface: session webhook text/markdown messages truncate around ~3800 chars,
 * and AI Card markdown blocks render blank past ~3000 CJK chars (issue #615).
 * All surfaces must therefore split through this module so the sizing rules —
 * code-point counting (never splits surrogate pairs), code-fence awareness and
 * no-newline fallback — stay consistent.
 */

/** Safe max length (code points) for session webhook text/markdown messages. */
export const MESSAGE_CHUNK_LIMIT = 3800;

/**
 * Safe max length (code points) for a single AI Card markdown block.
 * Kept conservative below the observed ~3000 CJK blank-render threshold.
 */
export const CARD_BLOCK_CHUNK_LIMIT = 2500;

/**
 * Split text at code-point boundaries without any line awareness.
 * Used as the fallback for a single line longer than `limit` (e.g. a huge
 * URL or a minified one-liner) so every path terminates.
 */
export function splitByCodePoints(text: string, limit: number): string[] {
  if (Array.from(text).length <= limit) {
    return [text];
  }
  const chunks: string[] = [];
  let buf = "";
  let bufLen = 0;
  for (let i = 0; i < text.length; ) {
    const cp = text.codePointAt(i) as number;
    const size = cp > 0xffff ? 2 : 1;
    if (bufLen + 1 > limit) {
      chunks.push(buf);
      buf = "";
      bufLen = 0;
    }
    buf += String.fromCodePoint(cp);
    bufLen += 1;
    i += size;
  }
  if (buf) {
    chunks.push(buf);
  }
  return chunks;
}

/**
 * Split text into chunks no longer than `limit` code points, preferring
 * newline boundaries and keeping fenced code blocks intact (re-opening and
 * re-closing fences across chunk borders). Lines longer than the whole
 * budget are hard-split at code-point boundaries first.
 */
export function splitMessageChunks(text: string, limit = MESSAGE_CHUNK_LIMIT): string[] {
  if (!text) {
    return [text];
  }
  if (Array.from(text).length <= limit) {
    return [text];
  }

  // Fence markers add up to 12 code points of overhead to a chunk
  // ("```\n" on reopen + "\n```" on close), so reserve that headroom in the
  // per-line budget. ponytail: a long line *containing* ``` can still be
  // hard-split mid-marker (fence state drifts); acceptable until proven real.
  if (limit <= 12) {
    return splitByCodePoints(text, limit);
  }
  const budget = limit - 12;

  // Pre-split oversized single lines so the line loop below always makes
  // progress. Fence bookkeeping is unaffected: pieces inside a fence carry
  // no ``` markers, so `inCode` stays true across them.
  const lines = text.split("\n").flatMap((line) => splitByCodePoints(line, budget));

  const chunks: string[] = [];
  let buf = "";
  let bufLen = 0;
  let inCode = false;

  for (const line of lines) {
    const lineLen = Array.from(line).length;
    // Unconditionally reserve 4 code points so a closing fence added at any
    // later point (a line just added may itself open a fence) stays in budget.
    const cap = limit - 4;
    if (bufLen + lineLen + (bufLen > 0 ? 1 : 0) > cap && bufLen > 0) {
      if (inCode) {
        buf += "\n```";
        chunks.push(buf);
        buf = "```";
        bufLen = 3;
      } else {
        chunks.push(buf);
        buf = "";
        bufLen = 0;
      }
    }
    buf += (buf ? "\n" : "") + line;
    bufLen += lineLen + (buf === line ? 0 : 1);
    const fenceCount = (line.match(/```/g) || []).length;
    if (fenceCount % 2 === 1) {
      inCode = !inCode;
    }
  }
  if (buf) {
    chunks.push(buf);
  }
  return chunks;
}
