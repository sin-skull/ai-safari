// This example was supplied by the user, not fetched or inferred by a model.
export const PHRASE_EXAMPLE = { q: 'もう恋なんてしないなんて', a: '言わないよ絶対' };
export function phraseKey(text) {
  return String(text || '').normalize('NFKC').trim()
    .replace(/[？?！!。\s]+$/gu, '')
    .replace(/の続き(?:は|を教えて)?$/u, '')
    .replace(/[「」『』“”"\s？?！!。]/gu, '').toLowerCase();
}
export function findPhrase(query, phrases) {
  const key = phraseKey(query);
  return key ? phrases.find(p => phraseKey(p.q) === key) : undefined;
}

// Only an explicit teaching command is saved; ordinary quoted discussion is not.
export function parsePhraseTeaching(text) {
  const match = String(text).trim().match(/^(.+?)(?:と言われたら|と聞かれたら)[、,\s]*[「『]([^」』]+)[」』]\s*(?:って|と)(?:答えて|返して)(?:ください)?[。！!\s]*$/u);
  if (!match) return null;
  const q = match[1].trim().replace(/^[「『](.*)[」』]$/u, '$1').trim();
  const a = match[2].trim();
  if (!phraseKey(q) || q.length > 200 || !a || a.length > 500) return null;
  return { q, a };
}
