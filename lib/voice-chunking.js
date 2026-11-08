/**
 * voice-chunking.js: bound a long voice transcript to the CANONICAL Ollama context window.
 *
 * WHY THIS EXISTS (2026-08-20): voice enrichment used to escalate `num_ctx` to 40960 for long
 * transcripts. That was survivable on qwen3.6:27b (20.3 GiB predicted). After the 2026-08-16
 * migration to qwen3.8:27b-q8_0, the same request predicts **35.5 GiB**, more than the Mac Mini
 * reliably has free (~38-39 GiB, and far less whenever anything else is resident). Ollama's
 * scheduler refused the load outright ("model predicted to exceed available memory, evicting"),
 * the client aborted at its 5-minute timeout, and the retry loop burned all 5 attempts. Net
 * effect: every recording long enough to escalate silently stopped being summarized, while short
 * ones kept working, so nothing looked broken. A 55-minute recording sat unsummarized for a day.
 *
 * THE FIX IS TO SHRINK THE REQUEST, NOT GROW THE WINDOW. Split the transcript into consecutive
 * sections that each fit the canonical window, digest each one, then summarize the digests. The
 * runner never moves, so voice also stops competing with receipt reading for the shared qwen
 * runner (the 2026-07-28 thrash class: see the README).
 *
 * NEVER TRUNCATE. Ollama truncates oversized input SILENTLY, which produces a confidently wrong
 * meeting summary rather than an error. Every function here either bounds the input honestly or
 * reports that it could not. It never quietly drops content.
 *
 * These are PURE functions (no model, no network, no DB) so they are unit-testable:
 * `node test/voice-chunking.test.mjs`.
 */

/**
 * Tokens left for the BODY (raw transcript or section digests) after the prompt scaffolding and
 * the reserved completion are paid for out of the canonical window.
 *
 * The window must hold prompt AND completion. `slack` mirrors ollama-context's ESTIMATE_SLACK so
 * this arithmetic sizes against the same conservative basis contextForTokens() uses.
 *
 * @param {object} a
 * @param {number} a.canonical    the model's canonical num_ctx (contextFor(model))
 * @param {number} a.slack        estimator slack ratio (ESTIMATE_SLACK)
 * @param {number} a.numPredict   completion tokens reserved for this call
 * @param {number} a.overheadTokens tokens the prompt scaffolding costs with an empty body
 * @returns {number} tokens available for the body (may be <= 0, which the caller must handle)
 */
export function bodyBudgetTokens({ canonical, slack, numPredict, overheadTokens }) {
  return Math.floor(canonical / slack) - numPredict - overheadTokens;
}

/**
 * Split text into consecutive pieces each within `budgetTokens`, preferring paragraph, then
 * sentence, then word boundaries so a section never opens mid-sentence.
 *
 * Guarantees: concatenating the pieces reproduces every non-whitespace character of the input, in
 * order. Content is never dropped; that is the whole point.
 *
 * `hardMaxTokens` is the real ceiling (what actually fits the window); `budgetTokens` is the
 * PREFERRED section size, which is usually smaller because more sections preserve more detail.
 *
 * @param {string} text
 * @param {number} budgetTokens preferred section size
 * @param {object} [opts]
 * @param {number} [opts.hardMaxTokens] the true ceiling; defaults to budgetTokens
 * @returns {string[]} one or more pieces (empty array only for empty input)
 */
export function chunkText(text, budgetTokens, { hardMaxTokens = budgetTokens } = {}) {
  const maxChars = Math.max(1000, Math.floor(budgetTokens) * 4); // estimateTokens' ~4-chars/token basis
  const hardMaxChars = Math.max(maxChars, Math.floor(hardMaxTokens) * 4);
  const out = [];
  let rest = String(text || '').trim();
  while (rest.length > maxChars) {
    const floor = Math.floor(maxChars * 0.5);
    let cut = rest.lastIndexOf('\n\n', maxChars);
    if (cut < floor) cut = rest.lastIndexOf('. ', maxChars);
    if (cut > 0 && cut < floor) cut = rest.lastIndexOf(' ', maxChars);
    if (cut < floor) cut = maxChars; // pathological run-on: hard cut rather than loop forever
    out.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut).trim();
  }
  if (rest) out.push(rest);
  // A boundary-aligned split can leave a tiny trailing runt (measured: three ~17k sections then a
  // 304-char tail). That runt costs a whole extra model call and, worse, pushes the section count
  // past what the final summarizing call can hold, forcing a needless extra fold. Absorb it into
  // the previous section whenever the HARD window still allows, which loses nothing.
  if (out.length > 1) {
    const last = out[out.length - 1];
    const prev = out[out.length - 2];
    if (last.length < maxChars * 0.25 && prev.length + 2 + last.length <= hardMaxChars) {
      out.splice(out.length - 2, 2, `${prev}\n\n${last}`);
    }
  }
  return out;
}

/**
 * The per-section digest prompt. Deliberately asks for MARKDOWN, not the final JSON schema: a
 * section is a fragment, and asking for the full schema per fragment invites the model to invent
 * an overall conclusion from partial information.
 */
export function buildChunkPrompt(sectionText, index, total) {
  return `You are digesting ONE consecutive section (${index} of ${total}) of a long voice transcript. Transcripts may mix languages; ignore obvious speech-to-text misrecognitions (spurious words in other scripts).

Write a DETAILED markdown digest of THIS SECTION ONLY. It gets combined with the other sections' digests to write the final summary, so preserve everything that summary will need:
- Every decision, number, price, date, name, and commitment, stated exactly as given.
- The REASONING and the TRADE-OFFS behind each point, not just the conclusion.
- Positioning, values, strategy, and framing language: the easiest things to lose and often the most important.
- Anything left unresolved, uncertain, or disagreed on.
- Action items, with the owner if one was named.

Do NOT write an overall conclusion: this is a partial section, not the whole meeting. Do NOT invent anything that is not in the section. Output ONLY markdown '## ' headings with '- ' bullets.

Section ${index} of ${total}:
"""
${sectionText}
"""`;
}
