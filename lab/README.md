# 試験室（lab/）

回答モデルを iPhone で落ちずに動かせる方式を探すための、アプリとは独立したページ。アプリの記憶（IndexedDB）には触れない。Service Worker もこのフォルダは扱わない。

- 保存先：`ai-safari-lab-cache`（OPFS）と専用のlocalStorageキー。元の試験室のモデル・記録とは別。実行ライブラリは変更せず、`storage.js` のバックエンドを渡す。
- 仕組み：wllama 3.6.1（llama.cpp の WebAssembly 版、MIT）。`vendor/` に同梱（外部CDNに頼らない）。Safari は互換版（`wllama-compat`）を使う。
- 動かし方：CPUだけ（`n_gpu_layers: 0`）／分担（半分の層だけGPU）／GPU（全部の層）。
- モデル：配管テスト用の極小モデル（`models/tiny-test.gguf`、意味のある答えは出さない。どの入力にも英小文字だけを返すように作った自作のもの）、LFM2 350M Q4_K_M（約230MB）、Qwen2.5 0.5B Q4_0（約430MB）。モデルは Hugging Face から取得し、wllama の保存領域（OPFS）に残る。
- 落ちたときの記録：動かす直前に localStorage に段階を書き、終わったら消す。次に開いたとき残っていれば「その途中で落ちた」と記録する。
