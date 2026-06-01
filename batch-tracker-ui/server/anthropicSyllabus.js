function extractJsonObject(text) {
  const t = String(text || "").trim();
  const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const raw = fence ? fence[1].trim() : t;
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) throw new Error("No JSON object in model response");
  return JSON.parse(raw.slice(start, end + 1));
}

/**
 * @param {Array<{ key: string, sheetRow: number, batch: number, week: number, syllabus: string }>} withTextEntries
 * @returns {Promise<Array<{ a: object, b: object, matchScore: number, matchPercent: number, note?: string, source: 'anthropic' }>>}
 */
export async function anthropicNearDuplicatePairs(withTextEntries, options = {}) {
  const {
    minScore = 75,
    model = process.env.ANTHROPIC_MODEL || "claude-sonnet-4-20250514",
    patternContext = null,
    patternSheetTitle = null,
  } = options;

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new Error("ANTHROPIC_API_KEY is not set. Add it to the server .env file (never commit it).");
  }

  if (!withTextEntries.length) return [];

  const maxItems = Math.min(Number(process.env.ANTHROPIC_MAX_ITEMS) || 72, 90);
  const maxChars = Math.min(Number(process.env.ANTHROPIC_MAX_CHARS_PER_SYLLABUS) || 3200, 12000);
  const slice = withTextEntries.slice(0, maxItems);

  const payload = slice.map((e) => ({
    key: e.key,
    sheetRow: e.sheetRow,
    syllabus:
      e.syllabus.length > maxChars ? `${e.syllabus.slice(0, maxChars)}\n…[truncated]` : e.syllabus,
  }));

  const { default: Anthropic } = await import("@anthropic-ai/sdk");
  const client = new Anthropic({ apiKey });

  let system = `You compare syllabus text items (same training program across batches/weeks).
Return ONLY a single JSON object (no markdown fences, no commentary) with this exact shape:
{"pairs":[{"key_a":"B6W13","key_b":"B7W13","similarity_0_to_100":88,"note":"one short phrase"}]}

Rules:
- Only include pairs where the two syllabi are substantially the same plan/inventory (minor wording, punctuation, or ordering differences are OK).
- Do NOT pair items that merely share a topic but are clearly different scope, different modules, or different week intent.
- Use the exact "key" strings from the input only. Each unordered pair at most once (key_a < key_b lexicographically if you need a tie-break).
- similarity_0_to_100 is your calibrated estimate: 100 = effectively identical content; below 70 = do not include.
- Cap the list at 80 pairs; prefer the strongest matches first.`;

  if (patternContext && String(patternContext).trim()) {
    const label = patternSheetTitle ? `tab "${patternSheetTitle}"` : "the Pattern sheet";
    system += `\n\nA separate "${label}" grid is provided after the items as reference for naming, sequencing, or structure. Use it only to inform what counts as the "same" syllabus; still base pair decisions on the Items list.`;
  }

  let userContent = `Items (JSON array):\n${JSON.stringify(payload)}`;
  if (patternContext && String(patternContext).trim()) {
    userContent += `\n\n---\nPattern / reference sheet (TSV columns, may be wide):\n${patternContext}`;
  }

  const msg = await client.messages.create({
    model,
    max_tokens: 16384,
    temperature: 0.1,
    system,
    messages: [{ role: "user", content: userContent }],
  });

  const textBlock = msg.content.find((b) => b.type === "text");
  const text = textBlock?.text || "";
  let parsed;
  try {
    parsed = extractJsonObject(text);
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    throw new Error(`Failed to parse Anthropic JSON: ${errMsg}. Raw (first 800 chars): ${text.slice(0, 800)}`);
  }

  const pairsRaw = Array.isArray(parsed.pairs) ? parsed.pairs : [];
  const byKey = new Map(slice.map((e) => [e.key, e]));

  const out = [];
  for (const p of pairsRaw) {
    const ka = String(p.key_a ?? "").trim();
    const kb = String(p.key_b ?? "").trim();
    const ea = byKey.get(ka);
    const eb = byKey.get(kb);
    if (!ea || !eb) continue;
    const sim = Number(p.similarity_0_to_100);
    if (Number.isNaN(sim) || sim < minScore) continue;
    const score = Math.min(100, Math.max(0, sim)) / 100;
    out.push({
      a: { key: ea.key, sheetRow: ea.sheetRow, batch: ea.batch, week: ea.week },
      b: { key: eb.key, sheetRow: eb.sheetRow, batch: eb.batch, week: eb.week },
      matchScore: score,
      matchPercent: Math.round(score * 1000) / 10,
      note: typeof p.note === "string" ? p.note.slice(0, 240) : undefined,
      source: "anthropic",
    });
  }

  out.sort((x, y) => y.matchScore - x.matchScore);
  return out;
}
