# 自然言語会話の実測と採用基準

実施日: 2026-10-13。対象アプリ: 0.14.0、開始時点のコミット `bc47d6b`（評価と読点の修正を0.14.1に追加）。

**結論: 自由会話の品質は未達。今は自然言語の品質改善を最優先にする。** 現行モデルの復唱、人物の取り違え、不自然な説明は、ブラウザ以外のllama.cppでも再現した。Safariだけの不具合として扱う根拠はない。一方、これだけでSafari上の読み込みや実行の問題をすべて除外したわけでもない。

## 確認したこと

`tests/quality-cases.mjs` に7場面・11発言を用意した。個人の会話履歴は公開せず、名前は架空のものに置き換えた。各場面に評価基準を付け、実際に生成された文章を読んで判定する。モデルがロードできたこと、文字が出たこと、辞書や登録フレーズが一致したことを自由会話の合格としない。

| 場面 | 確認する内容 |
| --- | --- |
| 疲れた相手への返事 | 相手に返答する。発言の復唱や話者の入れ替わりを避ける |
| 猫を迎える準備 | 指定した個数の具体例を挙げる |
| メーカー名 | 実在する該当例を挙げる。知らない企業を作らない |
| 名前を伝え、訂正する4発言 | 相手と自分を区別し、最新の訂正を保持する |
| 説明と続きの質問 | 直前の話題を踏まえた具体例を答える |
| 見えない冷蔵庫の中身 | 知らないと認める。見たふりをしない |
| 保存資料の閉館時刻 | 読み込んだ情報に沿って答える |

## 比較結果

以下は限られた例による比較で、総合性能のランキングや正答率ではない。同じseedでもCPU実装や計算精度、文脈のキャッシュなどで回答は異なり得る。

| 条件 | 観察 | 判断 |
| --- | --- | --- |
| 現行Qwen3 0.6B Q4 / ブラウザCPU / 現行指示 | 疲れた相手の発言を復唱。名前の訂正後も「私の名前は田中です」。閉館時刻も「午前9時から午後5時まで閉まります」 | 不合格 |
| 同じGGUF / llama.cpp b10663 CPU | 同様の復唱・人物の混同・反復が再現 | ブラウザ固有の原因とは言えない |
| 同じGGUF / llama.cpp b6000 CPU（6発言） | 古い実行エンジンでも復唱・人物の混同が残る | 実行エンジンの版を戻すだけでは改善しない |
| 現行0.6B / 短い日本語指示・話者の明記 | 一部の説明は改善するが、訂正や未知の質問への対応が崩れる | 指示の差し替えだけでは不十分 |
| Qwen3-0.6B_WBD Q8 / CPU | 資料の時刻、未知の質問への対応は改善した例があるが、名前の訂正や猫の準備、メーカー名が不自然 | 標準モデルへの採用を保留 |
| Qwen2.5 0.5B Instruct Q4 / CPU / 日本語指示 | 人物の混同、具体例の誤り、冷蔵庫の質問への反復が残る | 採用を保留 |
| Qwen3 1.7B Q4 / CPU / 現行指示 | 相手への返事や人物の区別が改善した例があるが、名前を聞き直すと自分の名前を答える。メーカー名にも誤り | 大型化だけでは合格しない |
| Qwen3 1.7B Q4 / ブラウザCPU / 現行指示 | 説明の日本語は一部改善したが、名前を訂正しても古い名前を答える。冷蔵庫の内容も推測で列挙する | ブラウザ上の会話品質も未達 |
| Qwen3 1.7B Q4 / CPU / 話者を明記した日本語指示 | 訂正後に「あなたの名前は佐藤です」、未知の質問に「わかりません」、閉館時刻にも答えられた。ただしメーカー名には不正確な出力が残る | 有望な部分はあるが、追加評価が必要 |

現行0.6Bで思考を有効にする比較も行った。単発で自然な返事が得られた一方、日本語指示での8発言の試行では人物の混同や誤答が残り、生成トークン数も増えた。思考を有効にすれば解決するとは判断していない。

1.7BはブラウザのWasm32互換CPUでもロード・生成できた。ただし、現行指示で最初の3問は約56〜68秒かかった。これはPC上での実測で、他の評価処理も一部並行していたため厳密な速度比較ではない。iPhoneでの速度・メモリ上限・安定性を示す数字ではなく、スマホ用の標準へ即座に置き換える根拠にはしない。

再現用の主要な生データは [quality-results](quality-results/) に保存する。回答の自然さと内容を直接比較できる。各JSONの `rows` はその実行で記録した全回答であり、良い回答だけを抜粋していない。

## 条件と出典

- Windows / Intel Core i7-6700 / RAM約24GB。CPUは1スレッド、コンテキスト2048、バッチ32、GPU層0。
- ブラウザ: 独立したheadless Chrome、wllama 3.6.1のWasm32互換版。サイトとGGUFは検証用localhostから取得し、外部へのブラウザ要求を遮断した。利用者の既存ブラウザや保存データを使わない。
- PC比較: wllamaの埋め込み版と同じ [llama.cpp b10663](https://github.com/ggml-org/llama.cpp/releases/tag/b10663)。追加確認にb6000を使用。PC内だけの検証用で、アプリをサーバー依存にする変更ではない。
- 通常比較: temperature 0.1、seed 42、最大160トークン、思考無効。独立場面ごとに履歴を空にし、複数ターンの場面は直前の実際の回答を履歴に入れた。
- 現行指示は `buildConversation` を使用。日本語指示の比較ではsystem本文を置き換え、資料は残した。試した指示本文は結果JSONに保存してある。

| モデル | 固定リビジョン | ファイル容量 |
| --- | --- | --- |
| [Unsloth Qwen3 0.6B Q4_K_M](https://huggingface.co/unsloth/Qwen3-0.6B-GGUF) | `50968a4468ef4233ed78cd7c3de230dd1d61a56b` | 396,705,472 bytes |
| [webbigdata Qwen3-0.6B_WBD Q8](https://huggingface.co/webbigdata/Qwen3-0.6B_WBD) | `789a31e3011376f1c5f1ace071ba81f39ed20b5a` | 639,447,552 bytes（2分割） |
| [Qwen2.5 0.5B Instruct Q4_K_M](https://huggingface.co/Qwen/Qwen2.5-0.5B-Instruct-GGUF) | `9217f5db79a29953eb74d5343926648285ec7e67` | 491,400,032 bytes |
| [Unsloth Qwen3 1.7B Q4_K_M](https://huggingface.co/unsloth/Qwen3-1.7B-GGUF) | `d7f544eead698dbd1f15126ef60b45a1e1933222` | 1,107,409,472 bytes |

Qwen3 0.6B、Qwen2.5 0.5B、Qwen3 1.7Bのダウンロード済みファイルは、配布元LFSのSHA-256と一致した。順に `ac2d97712095a558e31573f62f466a3f9d93990898b0ec79d7c974c1780d524a`、`74a4da8c9fdbcd15bd1f6d01d621410d31c6fc00986f5eb687824e7b93d7a9db`、`b139949c5bd74937ad8ed8c8cf3d9ffb1e99c866c823204dc42c0d91fa181897`。

## 再現手順

モデルとnative実行ファイルはgitに含めない。取得済みGGUFを `tests/.cache/quality/` に置く。通常のユニットテストはモデルを取得しない。

```powershell
# 独立したChromeで、取得済みモデルを実際に動かす。
$env:PLAYWRIGHT_MODULE = 'playwright'
$env:QUALITY_MODEL = 'tests/.cache/quality/qwen3-0.6b-q4.gguf'
$env:QUALITY_OUTPUT = 'tests/.cache/quality/browser-results.json'
node tests/quality-eval.cjs

# 別のターミナルでローカル比較用サーバーを起動する。
llama-server.exe -m tests/.cache/quality/qwen3-0.6b-q4.gguf --host 127.0.0.1 --port 18184 -c 2048 -t 1 -b 32 -ub 32 -ngl 0 -np 1 --jinja --reasoning off

# native比較。外部サーバーのURLは評価コード側で受け付けない。
$env:QUALITY_NATIVE = 'http://127.0.0.1:18184'
$env:QUALITY_OUTPUT = 'tests/.cache/quality/native-results.json'
node tests/quality-eval.cjs
Remove-Item Env:QUALITY_NATIVE
```

任意の `QUALITY_SYSTEM` で指示を比較できる。`QUALITY_CASES=care,roles` などで場面を限定できるが、限定した実行を全場面合格としない。`QUALITY_MODEL` は分割GGUFをカンマ区切りでも受け取る。JSONは各回答後に保存されるため、途中終了した場合は11発言すべてが揃ったかを必ず確認する。速度だけでなく、文法・意味・話者・事実・直前の文脈を人が確認する。

## 次の採用判断

この7場面だけへの最適化で終わらせず、別の名前・言い回し・話題と複数回の生成で再評価する。特に、日本語の複数ターン会話を学習したモデル、量子化による劣化、履歴と話者情報の渡し方を優先して検討する。資料で事実を補う場合も、資料の意味を読み違えずに答えることを確認する。

会話品質が通ってから、iPhone 17 Safariで機内モード・再起動・連続会話・停止・メモリ解放を検証する。今回の評価をもって実機対応や自然言語会話の完成とはしない。音声・コード生成・アプリ開発は、その基盤ができてから進める。


## 0.15.0 で追加した候補と場面（未評価）

実施予定。**ここに書いた候補は、まだどれも実モデルで評価していない**（0.15.0 を作った環境からは Hugging Face のモデルを取得できなかった）。

選んだ理由：これまでの候補（Qwen 系、LFM2 350M）は、いずれも多言語モデルを小さくしたもので、日本語の会話の基本（相手と自分の区別、訂正の保持、用語の意味）で崩れた。今回は、日本語で学習・調整されたものを中心に選んだ。

| 候補 | 元のモデル | ファイル（固定リビジョン） | 容量 | ライセンス |
| --- | --- | --- | --- | --- |
| Sarashina2.2 0.5B | sbintuitions/sarashina2.2-0.5b-instruct-v0.1 | mmnga/sarashina2.2-0.5b-instruct-v0.1-gguf `5c71186` Q4_K_M | 528,204,672 bytes | MIT |
| LFM2.5 1.2B JP | LiquidAI/LFM2.5-1.2B-JP-202606 | LiquidAI/LFM2.5-1.2B-JP-202606-GGUF `448ba3f` Q4_0 | 695,750,944 bytes | LFM Open License v1.0 |
| Sarashina2.2 1B | sbintuitions/sarashina2.2-1b-instruct-v0.1 | mradermacher/sarashina2.2-1b-instruct-v0.1-GGUF `3d1e495` Q4_K_M | 931,179,872 bytes | MIT |
| TinySwallow 1.5B | SakanaAI/TinySwallow-1.5B-Instruct | SakanaAI/TinySwallow-1.5B-Instruct-GGUF `38c003a` Q5_K_M | 1,125,051,232 bytes | Apache-2.0（Gemma Terms of Use も同梱） |

追加した場面（`tests/quality-cases.mjs`）：用語の説明（define）、雑談（smalltalk）、話題の切り替え（switch）、訂正（fix）。合格の目安は、基本的な説明・雑談・訂正・話題変更の4つを通過すること。通過した候補だけを iPhone Safari で試す。

`buildConversation` は 0.15.0 から、履歴を `selectHistory` で選び、訂正と利用者自身についての発言を最優先の事実として指示文に入れる。評価でも同じ関数を使うので、前回の結果との差には、モデルの違いとこの変更の両方が含まれる。

### 手順（PC）

```powershell
# 例：Sarashina2.2 0.5B。ほかの候補も同じ手順でファイル名だけ変える
$env:PLAYWRIGHT_MODULE = 'playwright'
$env:QUALITY_MODEL = 'tests/.cache/quality/sarashina2.2-0.5b-instruct-v0.1-Q4_K_M.gguf'
$env:QUALITY_OUTPUT = 'tests/.cache/quality/sarashina-0.5b-results.json'
node tests/quality-eval.cjs
```

### 手順（iPhone Safari）

PC の評価で4つの場面を通過した候補だけを試す。

1. https://sin-skull.github.io/ai-safari/ の ☰ メニュー →「アプリを更新」で 0.15.0 にする。
2. モデルで候補を選び、「会話を準備」を押す。初回は 0.5〜1.1GB をダウンロードする（Wi‑Fi）。
3. 次の順に送る：辞書に無い言葉の意味（例：「冗長ってどういう意味？」）、「最近急に寒くなってきたね。」、「ゲームとは何？一言で。」→「扇風機の羽根の掃除のしかたを教えて。」、「東京タワーの高さは？」→「違うよ、333メートルだよ。改めて高さを教えて。」。
4. 各回答の秒数と、読み込みの秒数を記録する（☰ メニュー →「診断」でも書き出せる。会話の本文は入らない）。
