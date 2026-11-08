Third-party notices for dsh-cost-speed

This package contains code and data ported from the following project.

-------------------------------------------------------------------------------
dsh-live-token-stats
https://github.com/better-er/dsh-live-token-stats
License text: https://github.com/better-er/dsh-live-token-stats/blob/main/LICENSE

Copyright (c) 2026 betterer
Licensed under the MIT License, reproduced in full below.

Ported into this package:

  lib/tokenizer/bpe.js           <- src/tokenizer/bpe.ts
  lib/tokenizer/incremental.js   <- src/tokenizer/incremental.ts
  lib/tokenizer/unescape.js      <- src/tokenizer/unescape.ts
  lib/tokenizer/bpe-data.json    <- the vocabulary, merge table and added-token
                                    table that upstream inlines in its bundle

Local modifications: the modules are plain ESM with JSDoc types rather than
TypeScript, the tokenizer tables live in bpe-data.json and load on demand
instead of being inlined, and a release() hook lets the host drop them again.
The tokenizer's statistics and merge order are unchanged, and encoding matches
upstream token id for token id on 263,730 characters of real session text.

The live throughput tracker in lib/index.js also derives from upstream's
src/tracker.ts; the density estimator it replaced is gone.

The vocabulary in bpe-data.json is the DeepSeek V4 tokenizer table that upstream
carries in its own bundle; it originates from DeepSeek's official tokenizer.

-------------------------------------------------------------------------------

MIT License

Copyright (c) 2026 betterer

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.