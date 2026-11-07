# Phase 2 — B (Bảo): UC-02 RAG có trích dẫn

Đọc trước: `phase-2.md` mục 1 (Q4, Q5), 5.3, 7, 8; đề UC-02, mục 2.3; `src/tools/search-code.ts`, `src/llm/model-resolver.ts`.

| # | Ngày | Việc | Trạng thái |
|---|---|---|---|
| B1 | 04/11 | Chunk Python bằng `ast`, tài liệu theo heading | done |
| B2 | 05/11 | Embedder, BM25, `RepoIndex.search` | done |
| B3 | 06/11 | Index tăng dần theo hash file | done |
| B4 | 07/11 | `answerQuestion`, `/ask`, kiểm tra trích dẫn, link bấm được | done; nối kind `ask-answer` (`AskAnswerView`) vào TUI là E5 bước 4 |
| B5 | 08/11 | Eval UC-02 ≥ 20 câu | đã chạy thật: Recall@5 0,77 < 0,8, trích dẫn hợp lệ 1; chưa đạt (#15, `docs/uc-02.md` mục 3.2) |

Kiểu dữ liệu (`Chunk`, `ScoredChunk`, `Citation`, `IndexDiff`, `Embedder`) cố định ở `phase-2.md` mục 5.3.

## B1. Chunking

Branch `b/b1-chunker`. Không cần D0: nếu D0 chưa merge, tạo `src/core/rag/types.ts` đúng mục 5.3 trong branch của mình (D0 tạo file giống hệt, rebase lấy bản của `main`).

```ts
// src/core/rag/chunker.ts
export const DOC_FILES: RegExp;   // /^(README|CONTRIBUTING|CHANGELOG|AGENTS)(\.\w+)?$|^docs\/.+\.(md|rst|txt)$/i
export function chunkRepo(root: string, opts?: { python?: string }): Promise<Chunk[]>;
export function chunkPython(relPath: string, source: string, python: string): Promise<Chunk[]>;
export function chunkMarkdown(relPath: string, source: string): Chunk[];
```

Bước:
1. Liệt kê file: `git ls-files` nếu `root` là repo git, không thì duyệt thư mục. Bỏ `.venv`, `__pycache__`, `.git`, `node_modules`, file `isSecretPath()` (`src/tools/permissions.ts`), file > 200 KB.
2. `chunkPython`: chạy `<python> -I -c <SCRIPT>` với `source` qua stdin, `python` = `opts.python ?? process.env.AXIOM_PYTHON ?? 'python3'`. `SCRIPT` là hằng chuỗi trong file TS: `ast.parse`, duyệt `Module.body` và thân `ClassDef`, in JSON `[{ symbol, kind, startLine, endLine }]`.
   - `startLine` = dòng của decorator đầu tiên nếu có, không thì `node.lineno`; `endLine` = `node.end_lineno`.
   - Hàm trong class: `kind: 'method'`, `symbol: 'Class.method'`. Class: một chunk `class` gồm dòng `class ...:` đến hết docstring (không gồm method).
   - Phần còn lại của module (import, hằng) gộp thành chunk `module`, `symbol: null`.
   - `SyntaxError` → cả file là 1 chunk `module`.
3. `chunkMarkdown`: cắt ở mỗi dòng `#`..`###`; `symbol` = nội dung heading; không có heading thì cả file 1 chunk `doc`.
4. File khác trong `DOC_FILES` (`.txt`, `.rst`): cả file 1 chunk `doc`, `fileType: 'text'`.
5. Chunk > 120 dòng: tách thành đoạn 120 dòng, giữ `symbol`.

Test `tests/rag-chunker.test.ts` (repo tạm trong `os.tmpdir()`, `skip` khi không có Python):
- `each top-level function is one chunk with exact line range`
- `methods are named Class.method and include decorators`
- `module-level code becomes one module chunk`
- `a file with a syntax error becomes one module chunk`
- `markdown is split at headings`
- `secret files and .venv are skipped`

Kiểm: `npx tsx --test tests/rag-chunker.test.ts && npm run lint`.

## B2. Embedder, BM25, search

Branch `b/b2-search`. Cần D0 (`ModelRole` có `'embed'`).

```ts
// src/core/rag/embedder.ts
export function createEmbedder(info: ModelInfo, opts?: { fetchImpl?: typeof fetch }): Embedder;
export function fakeEmbedder(dim?: number): Embedder;   // mặc định 64; băm mỗi token vào 1 chiều, chuẩn hoá L2; tất định
export function embedderFromConfig(config: AxiomConfig): Embedder;
// thiếu config.modelRoles.embed → throw Error('Set modelRoles.embed in ~/.axiom/config.json (see docs/guides/providers.md section 9)')

// src/core/rag/bm25.ts
export function tokenize(text: string): string[];       // tách camelCase, snake_case, chữ thường, bỏ token 1 ký tự
export class Bm25 { constructor(docs: readonly { id: string; text: string }[], k1?: number, b?: number); score(query: string): Map<string, number> }

// src/core/rag/index.ts
export class RepoIndex {
  static open(root: string, embedder: Embedder, opts?: { dir?: string }): Promise<RepoIndex>;
  update(): Promise<IndexDiff>;
  search(query: string, k?: number): Promise<ScoredChunk[]>;   // k mặc định 5
}
```

Bước:
1. `createEmbedder`:
   - `info.api === 'ollama-chat'`: `POST ${baseUrl}/api/embed`, body `{ model: info.id, input: texts }`, đọc `embeddings`.
   - còn lại: `POST ${baseUrl}/embeddings`, body `{ model: info.id, input: texts }`, header `Authorization: Bearer <key>` lấy theo cách `createProviderFor` lấy credential, đọc `data[i].embedding`.
   - Gửi theo lô 64 text. Lỗi HTTP → `ProviderError` (thông điệp qua `redact`).
2. Thư mục index: `opts.dir ?? path.join(axiomHome(), 'index', sha256(realpath(root)).slice(0, 12))`. Một file `index.json` = `{ meta: { embedModel, preprocessing, dim }, files: Record<path, sha256>, chunks: Chunk[], vectors: Record<chunkId, number[]> }` (Nhật ký quyết định 2026-11-04, #12, #13). Định danh trong `meta` đổi thì index lại toàn bộ.
3. `search(query, k)`: điểm cuối = `0.5 * cosine + 0.3 * bm25Norm + 0.2 * symbolMatch`.
   - `bm25Norm` = điểm BM25 chia điểm lớn nhất của truy vấn.
   - `symbolMatch` = 1 nếu một token của query trùng (không phân biệt hoa thường) phần cuối của `symbol` (`insert` khớp `Table.insert`), không thì 0.
   - Trả `k` chunk điểm cao nhất, cùng điểm thì `path` rồi `startLine` tăng dần.
4. Trọng số là hằng `SEARCH_WEIGHTS` đầu file; B5 có thể chỉnh, ghi lý do vào `docs/uc-02.md`.

Test `tests/rag-search.test.ts` (`fakeEmbedder`, `AXIOM_HOME` tạm, server giả `127.0.0.1` cho `createEmbedder`):
- `query with a symbol name ranks that chunk first`
- `bm25 favors rare terms`
- `ollama api posts to /api/embed`
- `openai-compatible api posts to /embeddings with bearer key`
- `missing modelRoles.embed throws a fix-it message`
- `changing embed model rebuilds the index`

Kiểm: `npx tsx --test tests/rag-search.test.ts && npm run lint`.

## B3. Index tăng dần

Branch `b/b3-incremental`.

Bước:
1. `update()`: tính sha256 từng file; so với `files` trong `index.json`.
   - File mới → `added`; hash khác → `changed`; có trong `files` mà mất → `removed`.
   - Chỉ chunk và embed lại file `added` + `changed`; xoá chunk + vector của `changed` + `removed` trước.
   - Publish: ghi cả index vào file tạm, `fsync`, rồi một `rename` thành `index.json`. Lúc mở, file hỏng hoặc chunk/vector/hash không khớp nhau thì bỏ cả index và dựng lại.
2. `search()` tự gọi `update()` nếu lần `update` cuối cách > 2 giây, để câu hỏi sau khi sửa code ra nội dung mới (đề UC-02 case 5).

Test `tests/rag-incremental.test.ts` (embedder giả đếm số text đã embed):
- `editing one file re-embeds only that file`
- `deleted file chunks disappear from search`
- `question after an edit returns the new content`
- `unchanged repo embeds nothing on update`

## B4. `/ask` và kiểm tra trích dẫn

Branch `b/b4-ask`. Cần B2.

```ts
// src/core/rag/citations.ts
export const CITATION_RE: RegExp;   // khớp "tinydb/table.py:L10-L25", "tinydb/table.py:L10-25" và "team:team-conventions.md:L3-L5" (source 'team')
export function parseCitations(text: string): Citation[];
export function validateCitation(c: Citation, root: string, retrieved: readonly Chunk[], teamDir?: string): string | null;   // teamDir mặc định TEAM_DOCS_DIR
export function checkSupport(claim: string, c: Citation, retrieved: readonly Chunk[]): string | null;
export function fileLink(root: string, c: Citation, teamDir?: string): string;   // OSC 8: \x1b]8;;file://<abs>#L<start>\x1b\\<path>:L<start>-L<end>\x1b]8;;\x1b\\

// src/agents/ask.ts — AskOptions, AskAnswer như phase-2.md mục 5.2
export const NOT_FOUND_TEXT = 'Không tìm thấy trong repo.';
```

`validateCitation` trả lý do khi:
1. file không tồn tại hoặc ngoài gốc của nguồn (`root`, hoặc `teamDir` với `source: 'team'`) → `'file not found'`;
2. `startLine < 1`, `endLine > số dòng file`, hoặc `startLine > endLine` → `'line out of range'`;
3. khoảng dòng không nằm trọn trong một chunk của `retrieved` cùng nguồn và `path` → `'not inside a retrieved chunk'`.

`checkSupport` (đề UC-02 tiêu chí 1: đoạn trích chứa symbol hoặc nội dung liên quan): câu chứa trích dẫn phải có ít nhất một từ (dài > 2, không phải từ đệm tiếng Anh) trùng với các dòng được trích hoặc `symbol` của chunk → không thì `'cited lines do not mention what the sentence says'`; câu chỉ có trích dẫn → `'no claim next to the citation'`.

`answerQuestion`:
1. `index.search(question, 5)`. Không có chunk nào điểm ≥ `MIN_SCORE` (hằng, B5 chỉnh) → `{ text: NOT_FOUND_TEXT, citations: [], found: false }`, không gọi model.
2. Prompt hệ thống: chỉ trả lời từ các đoạn đã cho; mỗi ý phải có `path:Lx-Ly` trong cùng câu và nêu tên symbol/thuật ngữ mà dòng được trích chứa; không đủ thông tin thì trả đúng `NOT_FOUND_TEXT`. Mỗi chunk đưa vào dạng `### <path>:L<start>-L<end> (<symbol>)` + code; chunk team có tiền tố `team:`.
3. Gọi `provider.chat` một lần (không tool). Với mỗi trích dẫn: `validateCitation`, rồi `checkSupport` với câu chứa nó.
4. Có trích dẫn sai → gọi lại model 1 lần, kèm danh sách lý do. Vẫn sai → xoá trích dẫn sai khỏi `text` (dòng không còn trích dẫn hợp lệ nào thì xoá cả dòng), thêm dòng cảnh báo cuối `text` (chỉ ghi số lượng, không ghi lại trích dẫn sai).
5. Câu trả lời không có trích dẫn hợp lệ nào và không phải `NOT_FOUND_TEXT` → `found: false`, `text = NOT_FOUND_TEXT`.

Lệnh `src/commands/ask.ts`: model `resolveModel('@default')`, embedder từ `embedModelFromConfig` (định danh `embedIdentity`), `teamDir: TEAM_DOCS_DIR`, trả `{ kind: 'ask-answer', data: AskAnswer, text }`. Headless in `text` với trích dẫn dạng chữ thường (không OSC 8).

TUI: `src/tui/components/citation.tsx` `export function AskAnswerView(props: { answer: AskAnswer; root: string; width: number })` thay mỗi trích dẫn bằng `fileLink`. Nhắn E kind `ask-answer`.

Test `tests/rag-citations.test.ts`:
- `parses both L10-L25 and L10-25 forms`
- `nonexistent file is rejected`
- `line past end of file is rejected`
- `range outside retrieved chunks is rejected`
- `valid citation passes`

Test `tests/ask.test.ts` (`MockProvider`, `fakeEmbedder`):
- `answer keeps only validated citations`
- `invalid citation triggers exactly one retry`
- `no relevant chunk returns not found without a model call`
- `fileLink wraps the citation in OSC 8`

## B5. Eval UC-02

Branch `b/b5-eval`.

1. `evals/uc02/questions.json`: ≥ 20 câu trên `workspace/tinydb`, mỗi câu:
   ```json
   { "id": "uc02-01", "kind": "locate", "question": "...", "expected": [{ "path": "tinydb/table.py", "startLine": 10, "endLine": 40 }], "edit": null }
   ```
   `kind` ∈ `locate` (≥ 6), `flow` (≥ 4, ≥ 2 file), `howto` (≥ 4), `absent` (≥ 3, `expected: []`), `after-edit` (≥ 3, `edit: { file, find, replace }` áp trước khi hỏi trên bản sao repo).
   Dòng `expected` lấy bằng `grep -n` trên `workspace/tinydb`, không đoán.
2. `evals/uc02/run.ts` export `runUc02: UcRunner`. Mỗi case chép `workspace/tinydb` vào `workDir`, áp `edit` nếu có, dùng `measureCase` (`evals/measure.ts`, A3).
3. `metrics` (#15): `recallAt5` = số đơn vị gold (mỗi khoảng `expected`) có trong top 5 / tổng đơn vị gold, không tính câu `absent`; `citationsValid` trên câu trả lời cuối của model; `abstentionRate` của câu `absent` báo riêng; `freshAfterEditRate`. Cách tính chi tiết: `docs/uc-02.md` mục 3.
4. `--mock`: `MockProvider` trả câu trả lời trích chunk đầu tiên + `fakeEmbedder`; chỉ kiểm pipeline.
5. Thêm `'02': runUc02` vào `evals/registry.ts`.
6. Chạy thật, ghi `docs/uc-02.md`: thiết kế (sơ đồ chunk → index → search → answer → validate), bảng từng câu, Recall@5, tỉ lệ trích dẫn hợp lệ, model chat và model embed, chi phí, failure mode.

Đạt: Recall@5 ≥ 0,8; `citationsValid = 1` trên mọi câu; mọi câu `after-edit` thấy nội dung mới.

Xong làn B khi: `/ask "Hàm insert nằm ở đâu?"` có trích dẫn bấm được; sửa file rồi hỏi lại ra nội dung mới; `/ask "Có hỗ trợ MongoDB không?"` trả `NOT_FOUND_TEXT`.
