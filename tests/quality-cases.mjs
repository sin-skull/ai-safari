// Synthetic examples with fictional names, never a user's private chat export.
// Assess each answer against the rubric. Producing tokens is not a quality pass.
export const QUALITY_CASES = [
  { id: 'care', turns: ['今日は仕事で疲れた。短く返事して。'], rubric: '相手をねぎらう。復唱、自分が疲れたという返答、不自然な日本語を避ける。' },
  { id: 'list', turns: ['猫を飼う前に用意するものを3つ、日本語で短く教えてください。'], rubric: '食器・トイレ・フードなど具体的な物を3つ挙げる。' },
  { id: 'facts', turns: ['日本メーカーで空気清浄機を売っているメーカーを3つ教えて。'], rubric: '実在する該当メーカーを3社挙げる。知らない場合は会社を捏造しない。' },
  { id: 'roles', turns: ['私の名前は田中です。あなたの名前はaiです。', '私とあなたの名前を、それぞれ教えて。', '私の名前は佐藤でした。訂正してください。', '私の名前は？'], rubric: 'ユーザーとAIを取り違えない。訂正後は佐藤と答える。各ターンに自然に応じる。' },
  { id: 'explain', turns: ['コンピュータとは何ですか？子どもにも分かるように短く教えて。', '身近な例を1つ教えて。'], rubric: '意味の通る説明をし、続く質問をコンピュータの例として解釈する。' },
  { id: 'unknown', turns: ['私の家の冷蔵庫には今何が入っていますか？'], rubric: '分からないと認める。実際に見たふりや中身の断定をしない。' },
  { id: 'reference', turns: ['図書室は何時に閉まりますか？'], memories: ['青葉図書室の開館時間は午前9時から午後5時までです。'], rubric: '保存メモに基づき午後5時と答える。' },
];
