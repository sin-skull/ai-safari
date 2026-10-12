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
