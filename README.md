# Page Chatbot (페이지 챗봇)

*English · [한국어](README.ko.md)*

A browser extension that opens a chatbot in the **right-hand side panel** and answers questions
about the page you are currently reading. It talks to a LiteLLM proxy (any OpenAI-compatible API)
and installs on **Chrome** and **Microsoft Edge**, including on Windows.

```
┌──────────────────────────────┬─────────────────────┐
│  The page you are reading    │  Page Chatbot       │
│                              │  ─────────────      │
│  (body text → prompt)        │  summarize / ask    │
│                              │  ▸ streamed answer  │
└──────────────────────────────┴─────────────────────┘
```

> **Note on language.** The extension's own UI, its default system prompt and its quick-prompt
> buttons are in Korean, because that is what it was built for. This README quotes those labels
> as they appear on screen, with an English gloss. The strings are plain text, but they are spread
> across `manifest.json` (name, description, toolbar tooltip), `src/lib/defaults.js` (system
> prompt, scope labels), `src/sidepanel/panel.html` / `panel.js` (panel UI, quick prompts),
> `src/options/options.html` / `options.js` (options page and its dialogs),
> `src/background/service-worker.js` (context-menu titles), `src/content/panel-host.js`
> (in-page panel tooltips) and `src/lib/llm.js` / `pages.js` (the error messages shown in the
> panel banner) — so translating the UI means editing all of those. There is no `_locales` setup yet.

## What it does

- Click the toolbar icon (or press `Alt+Shift+C`) and the chatbot opens in the browser's
  right-hand side panel.
- Every time you ask something it **reads the body text of the current tab** and sends it along
  with your question, so answers are grounded in what you are looking at.
- If the page is long it **picks only the paragraphs relevant to your question**, so an answer
  buried in the middle of a long document is still found.
- Click an **evidence chip** (📍) under an answer and the extension highlights that sentence on
  the page and scrolls to it.
- **`본문 입력` ("insert into the page")** puts an answer straight into a form on the page —
  a comment box, a mail body, a ticket field. If your cursor is already in a box it goes there;
  otherwise you pick the spot by clicking it on the page.
- Choose how much of the page to send: `전체 페이지` (whole page) / `선택 영역` (selection only) /
  `참조 안 함` (don't reference the page).
- Answers stream in and are rendered as Markdown (tables, code blocks, lists).
- On an empty panel, six one-tap action cards (summarize, key points, table, plain language,
  glossary, next steps) let you start without typing.
- Conversations are kept **per tab**; switching tabs switches to that tab's conversation.
  They are gone when you close the browser.
- Select text, right-click, and pick `선택한 내용을 페이지 챗봇에 묻기` ("ask the chatbot about the
  selection") to jump straight into a question.

## Requirements

| Item | Value |
| --- | --- |
| Browser | Chrome 116+ / Edge 116+ (the Side Panel API is 114+, `sidePanel.open()` is 116+) |
| Server | Any OpenAI-compatible `/chat/completions` endpoint, e.g. a LiteLLM proxy |
| Default base URL | `http://localhost:4000` |
| Default model | `gemini-flash` |

> Edge calls this API the "sidebar". It behaves the same as Chrome's side panel.

## 1. Install (developer mode, unpacked)

This is how to run it without publishing to a store. The repository folder is the extension.

**Chrome**

1. Open `chrome://extensions`.
2. Turn on **Developer mode** (top right).
3. Click **Load unpacked** and select this folder (the one containing `manifest.json`).
4. Click the puzzle-piece icon in the toolbar and pin **페이지 챗봇**.

**Microsoft Edge**

1. Open `edge://extensions`.
2. Turn on **Developer mode** (bottom left).
3. Click **Load unpacked** and select this folder.
4. In the extension list, enable "Show in toolbar" for **페이지 챗봇**.

> The options page opens automatically right after installation. To open it later, click ⚙ at the
> top right of the panel.

## 2. First-run setup

Only three fields matter.

| Field | Example | Equivalent OpenAI-SDK argument |
| --- | --- | --- |
| Server URL | `http://localhost:4000` | `base_url="http://localhost:4000/"` |
| API key | `sk-...` (**enter it yourself**) | `api_key="sk-..."` |
| Model | `gemini-flash` | `model="gemini-flash"` |

> **The API key ships empty on purpose.** A key hard-coded in the source would be copied into
> every package built from it, so you enter it once in the options page instead. Leave it blank if
> your server does not require authentication.

`연결 테스트` ("Test connection") lists the models (`GET /models`) and sends one short real
chat request, then shows the result. You do not need to include `/chat/completions` in the URL —
it is appended for you. Servers that expect `/v1` work too: just enter `http://localhost:4000/v1`.

### Preparing the server (for reference)

```yaml
# config.yaml
model_list:
  - model_name: gemini-flash          # ← must match the extension's "model" field
    litellm_params:
      model: gemini/gemini-2.0-flash
      api_key: os.environ/GEMINI_API_KEY
```

```bash
litellm --config config.yaml --port 4000
```

The extension sends exactly the kind of request below, against the same `/chat/completions`
endpoint any OpenAI-compatible client would use.

```bash
curl http://localhost:4000/chat/completions \
  -H "Authorization: Bearer sk-..." \
  -H "Content-Type: application/json" \
  -d '{"model":"gemini-flash","stream":true,"messages":[
        {"role":"system","content":"당신은 사용자가 현재 보고 있는 웹페이지를 함께 읽는 AI 어시스턴트입니다. ..."},
        {"role":"system","content":"[현재 페이지]\n제목: ...\n[페이지 내용] <<<PAGE_DATA>>> ... <<<END_PAGE_DATA>>>"},
        {"role":"user","content":"Summarize this page"}]}'
```

The default system prompt and the labels the extension generates inside the page block
(`[현재 페이지]`, `[페이지 내용]`, `제목:`, `사이트:`, `URL:`) are sent in Korean, exactly as shown;
the body itself is wrapped in `<<<PAGE_DATA>>>` / `<<<END_PAGE_DATA>>>` delimiters (see section 8).
Only the `user` message is whatever you typed.

## 3. Usage

| Action | How |
| --- | --- |
| Open the panel | Click the toolbar icon, or `Alt+Shift+C` |
| Send a question | `Enter`, or the ↑ button inside the input box (never fires while a Korean IME is composing) |
| New line | `Shift+Enter` |
| Stop generating | The ■ button inside the input box, or `Esc` |
| Check the evidence | Click an evidence chip under the answer → the sentence is highlighted on the page and scrolled into view (`(일부)` means only the beginning matched) |
| Clear highlights | `표시 지우기` ("clear highlights") on the evidence row |
| Insert an answer into the page | The `본문 입력` button under the answer — always visible, no hover needed. With a cursor already in a box it inserts immediately; otherwise a banner appears on the page and you click the box you want (`Esc` cancels) |
| Re-read the page | `⟳` on the top bar (ignores the cache and extracts again) |
| New conversation | `＋` at the top |
| Use only a selection | Select text on the page, then set the scope to `선택 영역` on the top bar |
| Change the shortcut | `chrome://extensions/shortcuts` (Edge: `edge://extensions/shortcuts`) |

Quick prompts: 요약 (summarize) · 핵심 포인트 (key points) · 표로 정리 (as a table) ·
쉽게 설명 (explain simply) · 용어 정리 (glossary) · 다음 행동 (next steps) ·
한국어 번역 (translate to Korean). They appear as cards on an empty panel; once a conversation
starts they collapse behind a `빠른 질문` toggle above the input box so the transcript keeps the space.

### Two panel positions

- **`브라우저 사이드 패널`** ("browser side panel" — default, recommended) — the browser's own
  right-hand side panel. It does not touch the page layout.
- **`페이지 안에 떠 있는 패널`** ("panel floating inside the page") — the extension's iframe is
  injected on the right of the page. You can drag its width, and it works where the browser's
  side panel is unavailable.

Switch between them under `패널 위치` ("panel position") in the options page.

## 4. Layout

```
manifest.json               extension definition (Manifest V3)
package.json                npm scripts (check / test / validate / dev / zip)
icons/                      16/32/48/128 icons
src/
  background/
    service-worker.js       toolbar icon, context menus, panel-mode switching
  sidepanel/
    panel.html / .css / .js chatbot UI (shared by the side panel and the in-page iframe)
  options/
    options.html / .css /.js options page, connection test
  content/
    extract.js              body-text extraction (injected; returns its result)
    probe.js                cheap "is the page unchanged?" check (for the cache)
    highlight.js            finds quoted sentences and highlights them (CSS Custom Highlight API)
    insert.js               puts an answer into a page input (picker overlay, framework-safe writes)
    panel-host.js           injects/toggles the in-page panel iframe
  lib/
    defaults.js             default settings and storage keys
    settings.js             read/write/normalize settings
    llm.js                  OpenAI-compatible calls, streaming, error messages
    sse.js                  SSE parser (pure)
    context.js              page text → prompt, relevant-paragraph selection (pure)
    pagecache.js            cache signature and freshness rules (pure)
    markdown.js             Markdown → safe HTML (pure)
    pages.js                decides whether a page can be scripted
test/
  *.test.js                 Node unit and integration tests (153)
  fixtures/                 sample pages for extraction checks (normal / awkward markup / shadow DOM)
  harness/                  dev harness that runs the UI without installing the extension
    chrome-shim.js          fake chrome.* API (tab switches, frames, queued prompts)
    panel-harness.html      chatbot panel
    options-harness.html    options page
    inpage-harness.html     in-page panel
    citation-check.html     automated highlight checks (8 cases)
    insert-check.html       automated insert checks (10 cases)
tools/validate.mjs          pre-install checks (syntax, paths, CSP, injected functions are self-contained)
tools/dev-server.mjs        dev server + fake LiteLLM (for the harness)
tools/pack.mjs              zip for store upload
```

### Layout notes

The panel is built for a narrow, short viewport, so the chrome is kept to two thin rows:

- **One top bar** — status dot, current page title, then the scope dropdown and the ⟳ / ＋ / ⚙
  buttons. The extension name is not repeated here because the browser's own side-panel header
  already shows it.
- **One line under the input box** — a reference badge (`전체 페이지 참조 중 · 1,034자`) and the
  model chip. Character/token details live in the badge's tooltip rather than on screen, and the
  line switches to the keyboard hint while the input box has focus.
- The send button (↑) sits inside the input box, which removes a whole row of padding.
- **No speaker labels.** Messages carry no "나" / "AI" row; your message is the narrower
  right-aligned bubble and the answer is the full-width one. Screen readers still get the speaker
  from a visually hidden label. That is 20px back per message (measured).
- **Answer actions are always visible** in a row under the answer bubble — `본문 입력` first and
  tinted, then `복사`, and `다시 생성` on the last answer. They used to appear only on hover, which
  hid the extension's main action well enough that people asked the chat to insert text for them.

## 5. How it works

1. The panel resolves the current tab and injects `extract.js` with `chrome.scripting.executeScript`.
2. `extract.js` strips ads, navigation, footers and the like, scores the remaining candidates to
   pick the main content, and turns it into text (plus title, description, selection and headings).
3. `context.js` builds the `[현재 페이지]` / `[페이지 내용]` blocks. If the body is longer than the
   configured character budget it keeps **only the paragraphs relevant to the question** (term
   overlap, weighted down for common words, normalized by paragraph length). Gaps between the
   chosen paragraphs are marked as elided, and a heading outline is sent so the model knows
   something was left out. When the question carries no usable terms (e.g. "summarize this"), it
   spends the character budget on the head and tail instead — the first 70% of the budget plus
   the last 30%, with the middle folded away and marked as elided — because a summary needs both
   the intro and the conclusion.
4. `context.js` assembles the final message array in the order `system prompt → page context →
   recent turns → question` (`buildMessages`), and `llm.js` posts it to `/chat/completions`.
5. `sse.js` parses the streamed response chunk by chunk and `markdown.js` converts it to safe HTML.

Extraction falls back through several strategies: semantic tags such as `article`/`main` →
paragraph-density scoring → the whole body → open shadow roots. If the content lives inside an
`iframe`, every frame is read and the longest result wins (title and URL always come from the top
frame). If noise removal was so aggressive that the content disappeared, the pre-cleanup snapshot
is restored.

The page context is **rebuilt on every question** and never stored in the conversation, so after
navigating away and asking a follow-up you always get an answer grounded in the current screen.

That does not mean re-extracting every time. On each question `probe.js` runs in **every frame**
and cheaply reports the URL, body length, per-frame lengths and a content fingerprint; if nothing
changed, the cached body is reused and only the **selection** is refreshed — which avoids
re-extracting and re-transferring a ~70,000-character body and tens of milliseconds of work on a
page the size of a Wikipedia article (measured: 69,722 characters, 26–41 ms per extraction). A changed URL,
length or fingerprint — or pressing `⟳` — triggers a fresh extraction. Empty results and
mid-load snapshots are never cached, so a page that renders late is not stuck as "no content".

When an answer finishes, sentences quoted with `"..."` are collected and **only those that really
appear on the page** become evidence chips. If a quote is not identical to the original and only
its beginning matches, the chip is marked `(일부)` ("partial") — a rewritten quote must not look
like verified evidence. Clicking a chip finds the sentence on the page: it handles sentences split
across inline tags (`<b>`, `<a>`) or `<br>`, and sentences inside open shadow roots, and when the
same sentence occurs several times it prefers the **visible one in the main content** (so it does
not jump to a duplicate in a table of contents, a menu or a hidden block). The page DOM is never
modified.

### Inserting an answer into the page

`본문 입력` is handled by [src/content/insert.js](src/content/insert.js), injected into **every
frame** (a composer often lives in an `<iframe>`).

- The answer is converted to plain text first, so `**`, `#` and backticks do not land in a form
  field. Structure survives: lists stay `- item`, tables stay `a | b`, code keeps its line breaks,
  and links become `text (url)`.
- Only fields that can actually take text are offered: `<textarea>`, text-like `<input>`
  (text/search/url/email/tel) and `[contenteditable]`. Read-only, disabled, password, number,
  checkbox and invisible fields are skipped.
- **Framework-safe writes.** Assigning to `element.value` leaves React's own value tracker in
  sync, so React concludes nothing changed and drops the text on submit. The extension calls the
  **prototype's native setter** and then dispatches `input` and `change` itself.
- **Rich editors** (Notion, Slack, Gmail) get `document.execCommand('insertText')` instead of DOM
  surgery, which keeps their formatting tree and undo history intact.
- If your cursor was already in the box, the text is inserted **at the caret** so what you had
  written is not overwritten. If the extension focused the box for you, it appends at the end.
- The picker overlay lives in a **closed shadow root** at the maximum z-index with
  `pointer-events: none`, so it cannot be covered by the page and does not swallow clicks.
  The click that selects a box is intercepted, so the site's own links and form submits do not fire.
- `Esc`, switching tabs, or picking again removes the overlay and every listener. A 60-second
  timeout is the last resort if the panel closes mid-pick.

## 6. Development

```bash
npm run check     # structure checks + unit tests
npm test          # unit tests only
npm run validate  # manifest/paths/CSP/syntax/self-contained injected functions
npm run dev       # dev server (+ fake LiteLLM) — drive the UI through the harness
npm run zip       # build dist/page-chatbot-<version>.zip
```

After changing code, hit reload (⟳) on `chrome://extensions`. If you only touched `panel.js` or
`panel.css`, closing and reopening the panel is enough.

### Checking the UI without installing anything

`test/harness/` fakes the `chrome.*` APIs so the panel and options page run as ordinary web pages.
You can verify rendering and streaming without loading the extension.

1. `npm run dev` starts a server on `http://127.0.0.1:8731` that serves the project **and**
   imitates LiteLLM's `/models` and `/chat/completions` (including SSE), so streaming works with
   no real server.
2. `/test/harness/panel-harness.html` — chatbot panel
3. `/test/harness/options-harness.html` — options page
4. `/test/harness/inpage-harness.html` — in-page panel
5. `/test/harness/citation-check.html` — automated highlight checks (8 cases)
6. `/test/harness/insert-check.html` — automated insert checks (10 cases)
7. Open `/test/fixtures/article.html` and paste this into the DevTools console to see exactly what
   the extractor returns:

```js
eval(await fetch('/src/content/extract.js').then((r) => r.text()))
```

The harness and fixtures are for verification only; `npm run zip` does not include them.

## 7. Troubleshooting

| Symptom | What to check |
| --- | --- |
| `... 에 연결하지 못했습니다` ("could not connect to ...") | Is LiteLLM running (`litellm --config config.yaml --port 4000`)? Are the host and port right? |
| `서버 오류 401` (server error 401) | Does the API key match the one the server issued? |
| `서버 오류 404` (server error 404) | Does the model name match `model_name` in `config.yaml`? Does your server need `/v1` in the URL? |
| Answers arrive but ignore the page | Is the dot on the top bar green, and is the scope something other than `참조 안 함` ("don't reference the page")? Hover the badge under the input box to see exactly how much is being sent |
| `브라우저 내부 페이지…는 읽을 수 없습니다` ("browser-internal pages cannot be read") | Extensions cannot read `chrome://`, `edge://` or store pages (browser policy) |
| Local files (`file://`) are not read | Enable **Allow access to file URLs** on the extension's details page |
| A PDF yields no text | Text in the built-in PDF viewer cannot be extracted; select the part you need and use selection mode |
| The side panel never opens | Upgrade to browser version 116+, or switch to `페이지 안에 떠 있는 패널` in the options |
| Clicking the icon does nothing | In in-page-panel mode, injection is blocked on pages like `chrome://`. Try an ordinary web page |
| The in-page panel is blank | Rarely, a browser may also require the iframe's sub-resources to be web-accessible. Add `"src/sidepanel/panel.css"`, `"src/sidepanel/panel.js"` and `"src/lib/*.js"` to `web_accessible_resources.resources` in `manifest.json` and reload |
| The content lives in an iframe | Every frame is read and the longest body wins. If it is still empty, hover the top-bar title to see why |

Extension pages may call any host listed in `host_permissions` without CORS restrictions, so
LiteLLM needs no special CORS configuration. If requests are still blocked, check the service
worker log (`chrome://extensions` → **service worker** for this extension) and the panel's own
DevTools (right-click the panel → Inspect).

## 8. Privacy and security

- The page text and your questions go **only to the server you configured**. Nothing is sent
  anywhere else.
- The API key is not in the source. What you type in the options page is stored in plain text in
  this browser profile's `chrome.storage.local`. Clear it after use on a shared machine.
- Saving a key in the options page for a **non-local** plain-`http` server asks for confirmation
  before it is stored (localhost never prompts). Chat requests and connection tests do not prompt
  again — the check happens at save time only.
- Conversations live in `chrome.storage.session` per tab and disappear when the browser closes.
  Closing a tab deletes that tab's conversation.
- The `<all_urls>` permission is what makes "read whatever page I am on and answer" possible. If
  you do not need that, set the scope to `참조 안 함`.

**Page content is treated as untrusted.** Because a web page ends up inside the prompt, the
extension assumes pages will try to instruct the model (prompt injection):

- The body is wrapped in `<<<PAGE_DATA>>>` delimiters together with an instruction not to follow
  anything inside them. If a page plants the same delimiters, they are stripped.
- Images in model output are rendered as **links**, not `<img>`. Remote images are fetched without
  a click, which — combined with injection — is a channel for smuggling conversation text out in
  a URL.
- All model output is HTML-escaped before rendering, and only `http`, `https` and `mailto` links
  are allowed.
- The in-page panel is an iframe inside a **closed shadow root**, so page scripts can read neither
  the panel's contents nor the extension ID.
- Exactly one file is exposed through `web_accessible_resources`: the panel HTML. Scripts holding
  settings or keys are not exposed.

## 9. Known limits

- **PDFs**: text in the browser's built-in PDF viewer is out of reach for extensions. Select the
  part you need instead.
- **Web components (shadow DOM)**: when the normal strategies find nothing, open shadow roots
  (including nested ones) are read as a fallback. Closed shadow roots are blocked by the browser.
- **Token counts while streaming**: if the server does not send `usage`, only elapsed time is
  shown. (`stream_options` is deliberately not sent because some backends reject it. Turn
  streaming off if you need exact token counts.)
- **Very long pages**: the body is truncated to the configured budget. Relevant paragraphs are
  selected, falling back to first-and-last when the question gives no clue. Highlight search scans
  the first 300,000 characters.
- **Inserting into the page**: works on real form fields only. Editors that draw their own
  surface (Google Docs' canvas renderer, Figma) cannot be targeted — the panel then says so and
  offers a copy button. Content inside a *closed* shadow root is also out of reach.
- **Evidence highlighting**: works only on text the browser has rendered. Text inside canvases,
  images or PDFs cannot be highlighted, and neither can a quote the model rewrote (a matching
  prefix is enough, though). Reloading the page clears the highlights.
