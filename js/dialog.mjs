// 会話の前処理（モデルに渡す前に、アプリが決めること）。ネットワークやブラウザの機能を使わない純粋な関数だけを置く。
//
// 1. 端末の情報で答えられる質問（時刻・日付・通信状態）は、モデルを使わずに答える。
// 2. 否定・訂正された回答は、以後の根拠から外す。訂正と利用者自身についての発言は、最優先の事実として渡す。
//    話題が変わったら、関係のない過去の回答は渡さない（小さなモデルは過去の答えの言い回しをそのまま写すため）。
// 3. 1回の送信に複数の依頼があれば分ける（用語の意味／おすすめ／ふつうの会話）。

const WEEK = ['日', '月', '火', '水', '木', '金', '土'];
const clean = (text) => String(text || '').normalize('NFKC').trim();

// ---- 1. 端末の情報 ----
// 「今何時？」「何時？」「現在時刻」。「何時に寝ればいい？」のような相談は含めない
const TIME_Q = /^(今|いま|現在)?(は|って)?\s*(何時|なんじ|何時何分)(です|だ)?(か|かな|？|\?|$)|今の時刻|現在(の)?時刻|時刻を教えて|時間を教えて/u;
const DATE_Q = /^(今日|きょう|本日)(は|って)?\s*(何日|なんにち|何月何日|何曜日?|なんようび|いつ)(です|だ)?(か|かな|？|\?|$)|(今日|きょう)の日付|今日の曜日|^何曜日(です|だ)?(か|？|\?|$)/u;
// 「オンライン？」「ネットつながってる？」「今オフライン？」。「オンラインとは？」のような意味の質問は含めない
const NET_Q = /^(これ|今|いま|ここ|この(アプリ|端末))?(は|って)?\s*(オンライン|オフライン)(モード)?(です|中|なの|ですか|になってる)?(か|？|\?|$)|(ネット|インターネット|通信|wi-?fi|ワイファイ)(に|は|が)?\s*(つなが|繋が)|通信(状態|できる|してる)|圏外/iu;
const MEANING_Q = /(とは|の意味|って何|ってなに|ってどういう)/u;

export function deviceAnswer(query, { now = new Date(), offline = false, online = true } = {}) {
  const q = clean(query).replace(/[。！!]+$/u, '');
  if (!q || q.length > 30 || MEANING_Q.test(q)) return null;
  const hh = now.getHours();
  const mm = String(now.getMinutes()).padStart(2, '0');
  const date = `${now.getFullYear()}年${now.getMonth() + 1}月${now.getDate()}日（${WEEK[now.getDay()]}）`;
  if (NET_Q.test(q)) {
    const text = offline
      ? 'いまはオフラインモードです（外部取得なし）。Wikipedia などへの通信はせず、端末に保存した内容とモデルだけで答えます。'
      : online
        ? 'いまは外部取得を許可しています。端末もネットにつながっているようです。会話の文章は、これまでどおり端末の中で作ります。'
        : '外部取得は許可していますが、端末がネットにつながっていないようです。端末に保存した内容で答えます。';
    return { kind: 'network', text };
  }
  if (DATE_Q.test(q)) return { kind: 'date', text: `今日は${date}です（この端末の時計）。` };
  if (TIME_Q.test(q)) return { kind: 'time', text: `いまは${hh}時${mm}分です（この端末の時計。${date}）。` };
  return null;
}

// ---- 2. 訂正・否定と、渡す履歴の選び方 ----
const CORRECTION = /^(いや|いいえ|違う|ちがう|違います|ちがいます|違うよ|そうじゃな|そうではな|間違|まちが|正しくは|おかしい|変だ|へんだ|意味(が)?(わから|分から)な|は\?|はあ|イカれ|いかれ|ふざけ)/u;
const CORRECTION_IN = /(じゃなくて|ではなくて|ではなく|じゃない(よ|です)|間違って(る|います)|違って(る|います)|関係な(い|く)|聞いてない|そんなこと言ってない)/u;
export function isCorrection(text) {
  const t = clean(text);
  if (!t || t.length > 120) return false;
  return CORRECTION.test(t) || CORRECTION_IN.test(t);
}

// 利用者が自分について述べた事実（「私の名前は佐藤です」など）。質問は含めない
const SELF_FACT = /^(私|わたし|僕|ぼく|俺|おれ|うち|自分)(の名前|の仕事|の年齢|の趣味)?(は|が)[^？?]{1,60}$/u;
export function isUserFact(text) {
  const t = clean(text).replace(/[。！!]+$/u, '');
  return SELF_FACT.test(t) && !/(何|なに|誰|だれ|どこ|いつ|どう|ですか|かな)$/u.test(t);
}

// 直前の話題の続きか（指示語・続きを促す言葉・相づち）
const FOLLOW = /^(それ|これ|あれ|その|この|あの|そこ|じゃあ|では|なんで|なぜ|どうして|もっと|他に|ほかに|詳しく|くわしく|続き|つまり|それで|でも|だから|例えば|たとえば|具体的に)|(さっき|前の|先ほど|今の)(話|答え|回答|質問)?|(それ|これ|あれ)(って|は|を|の|に|も)/u;
const RECALL = /(覚えて|おぼえて|さっき|前に|名前|言ったこと|何て言った)/u;
export const isFollowUp = (text) => FOLLOW.test(clean(text));
// 相づち（直前の答えへの反応）
const ACK = /^(はい|うん|ええ|そう(なんだ|なの|か|です)?|なるほど|ありがとう|了解|わかった|分かった|ok|おけ|へえ|ふーん|すごい|いいね)/iu;

// 内容語の2文字の並び（ひらがなだけの並びは、助詞などが多いので数えない）
function contentGrams(text) {
  const t = clean(text).toLowerCase();
  const grams = new Set();
  for (let i = 0; i + 1 < t.length; i++) {
    const g = t.slice(i, i + 2);
    if (/^[\p{Script=Hiragana}ー\s、。？?！!「」]+$/u.test(g)) continue;
    grams.add(g);
  }
  return grams;
}
export function overlap(a, b) {
  const qa = contentGrams(a);
  if (!qa.size) return 0;
  const qb = contentGrams(b);
  let hit = 0;
  qa.forEach((g) => {
    if (qb.has(g)) hit++;
  });
  return hit / qa.size;
}

// モデルが作った答えだけを、過去の文脈の候補にする（端末の情報・教えたフレーズ・辞書の答えは写させない）
const MODEL_SOURCE = (pair) => !pair.source || pair.source === 'model';

// 今の質問に渡す履歴を選ぶ。戻り値：past（渡す往復）、facts（最優先の事実）
export function selectHistory(query, history, { maxPairs = 6 } = {}) {
  const rows = Array.isArray(history) ? history : [];
  const facts = [];
  for (const pair of rows) {
    if (typeof pair?.q !== 'string') continue;
    if (pair.correction || isUserFact(pair.q)) facts.push(clean(pair.q).slice(0, 120));
  }
  const usable = rows.filter((p) => p && p.q && p.a && !p.interrupted && !p.rejected && MODEL_SOURCE(p));
  const q = clean(query);
  let past = [];
  if (RECALL.test(q)) {
    past = usable.slice(-maxPairs); // 会話そのものを聞いている
  } else if (classify(q).kind === 'define' && !/^(それ|これ|あれ|その|この|あの)/u.test(q)) {
    past = []; // 用語の意味を聞いている。過去の答えを渡すと、その言い回しを写してしまう
  } else if (isFollowUp(q) || ACK.test(q)) {
    past = usable.slice(-1); // 直前の話題の続き・短い相づち
    const last = rows[rows.length - 1];
    if (last && (last.rejected || !MODEL_SOURCE(last) || last.interrupted)) past = []; // 直前が否定された・モデルの答えでない
  } else {
    // 話題が変わったら、内容が重なる往復だけを残す（直近から最大2件）
    past = usable.filter((p) => overlap(q, `${p.q} ${p.a}`) >= 0.25).slice(-2);
  }
  return { past, facts: [...new Set(facts)].slice(-5) };
}

// 訂正が来たときの履歴の更新：直前のモデルの答えを「否定された」とし、訂正を事実として残す
export function applyCorrection(history, text) {
  const rows = Array.isArray(history) ? history : [];
  for (let i = rows.length - 1; i >= 0; i--) {
    const p = rows[i];
    if (!p || p.interrupted) continue;
    if (MODEL_SOURCE(p) && p.a) {
      p.rejected = true;
      break;
    }
    break;
  }
  return { correction: true, text: clean(text) };
}

// ---- 3. 複数の依頼を分ける ----
const DEFINE = /(の意味|とは|って何|ってなに|ってなん|ってどういう意味|ってどうゆう意味|ってどんな意味|の読み方)/u;
const RECOMMEND = /(おすすめ|オススメ|お勧め|お薦め|どれがいい|どれを買|何を買|どこのメーカー|どのメーカー|選び方)/u;
const SPLIT_AFTER = /(の意味|とは|って何|ってなに|ってどういう意味|ってどうゆう意味|おすすめ|オススメ|お勧め|教えて)([？?]?)(?:と|、|，|,|それと|あと|それから)/u;

export function classify(text) {
  const t = clean(text);
  if (RECOMMEND.test(t)) {
    const topic = t
      .replace(/^(あと|それと|それから|ところで)[、,\s]*/u, '')
      .replace(/(って|は|で|の)?\s*(どこの|どの)?(メーカー|会社|ブランド)?\s*(が|を|は)?\s*(おすすめ|オススメ|お勧め|お薦め|どれがいい|どれを買|何を買|選び方).*$/u, '')
      .replace(/(って|は|で|の|を)$/u, '')
      .trim();
    return { kind: 'recommend', text: t, topic: topic || t };
  }
  if (DEFINE.test(t)) {
    const term = t
      .replace(/^(あと|それと|それから|ところで)[、,\s]*/u, '')
      .replace(/[?？!！。\s]+$/u, '')
      .replace(/(?:ってどういう意味|ってどうゆう意味|ってどんな意味|ってなに|ってなん|って何|とは何ですか|とはなに|とは何|とは|の意味を教えて|の意味は|の意味|の読み方).*$/u, '')
      .replace(/^[「『]|[」』]$/gu, '')
      .trim();
    if (term && term.length <= 30) return { kind: 'define', text: t, term };
  }
  return { kind: 'chat', text: t };
}

export function splitRequests(query) {
  const parts = [];
  for (const sentence of clean(query).split(/(?<=[。？?！!])|\n+/u)) {
    let rest = sentence.trim();
    while (rest) {
      const m = rest.match(SPLIT_AFTER);
      if (!m || m.index + m[0].length >= rest.length) {
        parts.push(rest);
        break;
      }
      const cut = m.index + m[1].length + m[2].length;
      parts.push(rest.slice(0, cut).trim());
      rest = rest.slice(m.index + m[0].length).trim();
    }
  }
  return parts.filter((p) => p.replace(/[。？?！!、\s]/gu, '')).map(classify);
}

// おすすめの依頼に、すぐ商品名を作らせない。条件を聞いてから、根拠のある範囲で答える
export function recommendQuestion(topic) {
  return `${topic}のおすすめですね。条件を教えてください。\n・使う場所や広さ（例：6畳の寝室）\n・予算\n・重視すること（静かさ、首振り、タイマー、電気代など）\nこの端末のモデルは最新の商品情報を持っていないので、条件に合う選び方を答えます。保存した資料に商品の情報があれば、それも使います。`;
}
export function recommendInstruction(topic, conditions) {
  return `利用者は「${topic}」のおすすめを求めている。条件：${conditions}。具体的な商品名・メーカー名・型番・価格は、保存メモにあるものだけを使い、作らない。保存メモに無ければ、条件に合う選び方（確認すべき点）を2〜4個、理由と一緒に答える。分からないことは分からないと言う。`;
}
