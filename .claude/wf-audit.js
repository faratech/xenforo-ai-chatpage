export const meta = {
  name: 'chatpage-audit',
  description: 'Audit the XenForo AI chatpage across 8 dimensions, adversarially verify each finding, synthesize a file-grouped improvement blueprint',
  phases: [
    { title: 'Audit', detail: '8 parallel finders, read-only' },
    { title: 'Verify', detail: 'adversarial verification per finding' },
    { title: 'Synthesize', detail: 'dedup + group by file + prioritize' },
  ],
}

// ---- Shared context handed to every agent ----
const CONTEXT = `
PROJECT: /web/xenforo-ai-chatpage — a TypeScript React 19 chat UI embedded in the XenForo
forum at windowsforum.com/chatpage. Stack: Vite 8 + React 19 + MUI 9 + Emotion + marked +
DOMPurify. NO test runner, NO ESLint config currently. Builds with 'npx vite build' to dist/.
Deployed (by a human, not you) to /web/public_html/chatpage via deploy.sh.

IMPORTANT FACTS / CONSTRAINTS:
- Env vars are Vite-style: import.meta.env.VITE_* (NOT CRA's REACT_APP_*).
- The working tree has IN-FLIGHT uncommitted improvements (better SSE event-boundary parsing,
  conversation history serialization, localStorage pruning, CaptchaRequiredError, refusal
  events). Treat the CURRENT working tree as the baseline to improve. DO NOT propose reverting
  these; build on them.
- 'vite build' currently SUCCEEDS. 'npx tsc --noEmit' currently FAILS only on a tsconfig
  baseUrl TS6 deprecation (TS5101). That tsconfig fix is in-scope.
- The "consistent filenames" output in vite.config.ts (static/js/main.js, static/css/main.css,
  no hashes) is INTENTIONAL for XenForo template integration — do NOT propose hashing them.
- Messages render model output via dangerouslySetInnerHTML after marked()+DOMPurify.sanitize().
- Files (relative to project root):
  src/index.tsx, src/App.tsx, src/App.css, src/index.css
  src/components/ChatWindow.tsx (709 lines, the main component)
  src/components/Message.tsx, src/components/InputArea.tsx,
  src/components/ConversationSidebar.tsx, src/components/ErrorBoundary.tsx
  src/services/api.ts (ChatAPI, AudioService, CaptchaRequiredError)
  src/config/env.ts, src/types/index.ts, src/utils/helpers.ts
  vite.config.ts, tsconfig.json, package.json, index.html, deploy.sh, build.sh
  CLAUDE.md, AGENTS.md, README.md (docs)

You have Read/Grep/Glob/Bash. Read the actual files before asserting anything — cite real
file:line. Do not invent issues; every finding must be grounded in code you read.
`

const FINDINGS_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['dimension', 'findings'],
  properties: {
    dimension: { type: 'string' },
    findings: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['id', 'title', 'file', 'lines', 'severity', 'category', 'description', 'proposedFix', 'confidence'],
        properties: {
          id: { type: 'string', description: 'stable kebab-case slug unique within this dimension' },
          title: { type: 'string' },
          file: { type: 'string', description: 'repo-relative path' },
          lines: { type: 'string', description: 'line or range, e.g. 162 or 245-251' },
          severity: { type: 'string', enum: ['critical', 'high', 'medium', 'low'] },
          category: { type: 'string', enum: ['bug', 'security', 'a11y', 'perf', 'types', 'ux', 'docs', 'tooling'] },
          description: { type: 'string', description: 'what is wrong and why it matters, grounded in the code' },
          proposedFix: { type: 'string', description: 'concrete, specific change to make' },
          confidence: { type: 'number', description: '0..1 that this is a real, worthwhile issue' },
        },
      },
    },
  },
}

const VERDICT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['id', 'isReal', 'severity', 'reasoning', 'fixIsSafe', 'refinedFix', 'regressionRisk'],
  properties: {
    id: { type: 'string' },
    isReal: { type: 'boolean', description: 'true only if you confirmed the issue against the actual code' },
    severity: { type: 'string', enum: ['critical', 'high', 'medium', 'low'] },
    reasoning: { type: 'string' },
    fixIsSafe: { type: 'boolean', description: 'true if the proposed fix is correct and will not break the build or existing behavior' },
    refinedFix: { type: 'string', description: 'the corrected/sharpened fix instruction an implementer should follow' },
    regressionRisk: { type: 'string', description: 'what could regress; "none" if trivial' },
  },
}

const BLUEPRINT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['summary', 'fileWorkPackets', 'globalRisks', 'outOfScope'],
  properties: {
    summary: { type: 'string', description: 'executive summary of the improvement plan' },
    fileWorkPackets: {
      type: 'array',
      description: 'one packet PER FILE so each can be implemented by an isolated agent with no edit conflicts',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['file', 'isNew', 'rationale', 'changes'],
        properties: {
          file: { type: 'string' },
          isNew: { type: 'boolean' },
          rationale: { type: 'string' },
          changes: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              required: ['findingId', 'title', 'severity', 'instruction'],
              properties: {
                findingId: { type: 'string' },
                title: { type: 'string' },
                severity: { type: 'string', enum: ['critical', 'high', 'medium', 'low'] },
                instruction: { type: 'string', description: 'precise implementation instruction' },
              },
            },
          },
        },
      },
    },
    globalRisks: { type: 'array', items: { type: 'string' } },
    outOfScope: { type: 'array', items: { type: 'string' }, description: 'things deliberately NOT done and why' },
  },
}

const DIMENSIONS = [
  {
    key: 'correctness',
    prompt: `Audit for CORRECTNESS & REACT BUGS. Focus: state races & stale closures, effect
cleanup (Turnstile script add/removeChild under StrictMode double-invoke), message id collisions
(msg_\${Date.now()} can collide within 1ms for user+ai), unreachable/dead branches (e.g. the
'result === null' branch in ChatWindow.handleSendMessage vs sendMessage's non-null return type),
AbortController handling, localStorage.setItem quota errors not caught in the save effect,
JSON.parse of untrusted localStorage, the captcha resend path, scroll-to-bottom correctness,
speech-recognition lifecycle. Read ChatWindow.tsx, api.ts, App.tsx, index.tsx, helpers.ts.`,
  },
  {
    key: 'security',
    prompt: `Audit for SECURITY & SANITIZATION. Focus: helpers.ts sanitizeAndParse — citation/source
HTML is built from model-provided URLs/text and concatenated into HTML, then marked()+DOMPurify.
Verify ordering (sanitize must be the LAST step on final HTML), reverse-tabnabbing (target=_blank
needs rel="noopener noreferrer"), whether DOMPurify default config keeps target/rel and strips
javascript: URLs, href injection via unescaped interpolation, prototype-pollution via JSON.parse of
localStorage 'chat_conversations', SSE JSON parsing safety, and any innerHTML use in
extractTextFromHTML. Read helpers.ts, api.ts, ChatWindow.tsx, Message.tsx.`,
  },
  {
    key: 'a11y',
    prompt: `Audit for ACCESSIBILITY. Focus: the messages list should be a live region
(role="log" aria-live="polite") so screen readers announce streaming; icon-only buttons missing
aria-label (some rely on Tooltip only); focus management on edit/captcha; keyboard operability of
example-prompt Chips (clickable but not buttons); heading semantics; color-contrast of hardcoded
hex (#4299E1 links, opacity:0.6 captions); the streaming caret '▍'; prefers-reduced-motion for
Fade. Read Message.tsx, InputArea.tsx, ChatWindow.tsx, ConversationSidebar.tsx, ErrorBoundary.tsx.`,
  },
  {
    key: 'perf',
    prompt: `Audit for PERFORMANCE. Focus: ChatWindow re-runs sanitizeAndParse (marked+DOMPurify)
on the streaming message on EVERY delta chunk (line ~630) — expensive for long responses; the
onChunk handler rebuilds strings each delta; Message is memo'd — verify props are stable; consider
debouncing/throttling streaming sanitize; vendor chunk is 450kB (141kB gzip) — assess MUI tree-shaking
/ icon imports / code-splitting; long message lists are not virtualized; useMemo/useCallback dep
correctness. Read ChatWindow.tsx, Message.tsx, helpers.ts, vite.config.ts, package.json.`,
  },
  {
    key: 'types',
    prompt: `Audit for TYPE SAFETY. Focus: 'any' usage — payload:any, errorData:any, parsedData:any,
backendError:any, speechRecognition useState<any>, window as any (turnstile, SpeechRecognition).
Propose precise types: an SSE event discriminated union, a SpeechRecognition typing or @types,
typed error classes, removing the impossible 'result === null' check or making the return type honest.
Also tsconfig baseUrl TS5101 deprecation (this MUST be fixed; prefer replacing baseUrl with paths or
adding ignoreDeprecations). Read api.ts, ChatWindow.tsx, types/index.ts, tsconfig.json.`,
  },
  {
    key: 'ux',
    prompt: `Audit for UX & EDGE CASES. Focus: mute state default & non-persistence (resets every
load), TTS errors swallowed silently, error-message UX (raw "Server error: ..." surfaced), no retry
affordance, empty/loading/offline states, copy-button feedback, edit only on last user message,
regenerate flow, mobile responsiveness/viewport, the "Sources" block inline styles using
rgba(255,255,255,0.2) borders that are invisible in light mode, citation rendering duplicated between
helpers.ts and ChatWindow.tsx. Read ChatWindow.tsx, Message.tsx, InputArea.tsx, helpers.ts, App.css.`,
  },
  {
    key: 'docs',
    prompt: `Audit for DOCUMENTATION DRIFT & DEV TOOLING. Focus: CLAUDE.md, AGENTS.md, README.md all
describe Create React App (npm start :3000, REACT_APP_*, build/ output, build:consistent, npm test
watch) but the app is Vite (VITE_*, dist/, scripts dev/build/preview/deploy). Enumerate EVERY
inaccurate claim with the corrected text. Also: package.json uses "*" for @emotion deps (unpinned),
missing scripts (typecheck, lint, test, preview is present), no ESLint/Prettier config, no tests at
all, src/.npmrc legacy-peer-deps in an odd location. Read CLAUDE.md, AGENTS.md, README.md, package.json,
tsconfig.json. Propose concrete doc rewrites and a minimal tooling setup (eslint flat config, a
'typecheck' script, a vitest smoke test).`,
  },
  {
    key: 'build',
    prompt: `Audit for BUILD / CONFIG / DEPLOY. Focus: tsconfig (baseUrl deprecation, target ES2020 vs
React19, strict flags), vite.config manualChunks (only vendor; could split MUI/marked), sourcemap:false
(no prod debugging), deploy.sh 'rm -rf /web/public_html/chatpage/*' safety, env.ts validation only warns,
build.sh redundancy, missing .env handling, index.html references /chatpage/favicon.ico & manifest.
Do NOT propose hashing filenames (intentional). Read vite.config.ts, tsconfig.json, deploy.sh, build.sh,
package.json, index.html, env.ts.`,
  },
]

phase('Audit')
log(`Auditing ${DIMENSIONS.length} dimensions in parallel, then adversarially verifying each finding`)

// Pipeline: each dimension is found, then ALL its findings are verified — no global barrier,
// so verification for 'correctness' starts while 'build' is still being audited.
const perDimension = await pipeline(
  DIMENSIONS,
  (d) => agent(`${CONTEXT}\n\n=== YOUR TASK ===\n${d.prompt}\n\nReturn 3-8 of the most worthwhile findings (quality over quantity). Set the 'dimension' field to "${d.key}".`,
    { label: `audit:${d.key}`, phase: 'Audit', schema: FINDINGS_SCHEMA, agentType: 'Explore' }),
  (res, d) => {
    const findings = (res && res.findings) || []
    if (findings.length === 0) return { dimension: d.key, verified: [] }
    return parallel(findings.map((f) => () =>
      agent(`${CONTEXT}\n\n=== ADVERSARIAL VERIFICATION ===\nAnother agent reported this finding in dimension "${d.key}". Independently verify it against the ACTUAL code. Try to REFUTE it. If the code does not actually have this problem, set isReal=false. If real, confirm severity, check the proposed fix is correct AND will not break the build or in-flight behavior, and write a sharpened refinedFix.\n\nFINDING:\n${JSON.stringify(f, null, 2)}`,
        { label: `verify:${d.key}:${f.id}`, phase: 'Verify', schema: VERDICT_SCHEMA, agentType: 'Explore' })
        .then((v) => (v ? { ...f, verdict: v } : null))
        .catch(() => null)
    )).then((arr) => ({ dimension: d.key, verified: arr.filter(Boolean) }))
  }
)

// Collect confirmed findings (real + safe-ish fix). Keep low-confidence refuted ones out.
const confirmed = []
for (const dim of perDimension) {
  if (!dim) continue
  for (const item of dim.verified) {
    const v = item.verdict
    if (v && v.isReal) {
      confirmed.push({
        dimension: dim.dimension,
        id: item.id,
        title: item.title,
        file: item.file,
        lines: item.lines,
        severity: v.severity || item.severity,
        category: item.category,
        description: item.description,
        fix: v.fixIsSafe ? v.refinedFix : `${v.refinedFix} (CAUTION: ${v.regressionRisk})`,
        fixIsSafe: v.fixIsSafe,
        regressionRisk: v.regressionRisk,
      })
    }
  }
}

log(`Confirmed ${confirmed.length} findings across ${perDimension.length} dimensions; synthesizing blueprint`)

phase('Synthesize')
const blueprint = await agent(
  `${CONTEXT}\n\n=== SYNTHESIZE THE IMPLEMENTATION BLUEPRINT ===\nBelow are ${confirmed.length} adversarially-confirmed findings. Produce a single coherent improvement plan, GROUPED BY FILE (one work packet per file) so each file can be implemented by an isolated agent with zero edit conflicts. Rules:\n- Merge duplicate/overlapping findings (e.g. citation rendering duplicated in helpers.ts and ChatWindow.tsx) into one coherent instruction.\n- For each file packet, order changes by severity and give precise, self-contained instructions an implementer can follow without re-reading every finding.\n- Include NEW files where warranted (eslint config, a vitest smoke test + setup, etc.) as packets with isNew=true. Keep new tooling MINIMAL and guaranteed not to break 'vite build'.\n- Doc fixes (CLAUDE.md, AGENTS.md, README.md) each get their own packet with the exact corrections.\n- package.json and tsconfig.json each get exactly ONE packet (merge all changes touching them).\n- Note anything deliberately out of scope (e.g. message-list virtualization if too invasive) in outOfScope with a reason.\n- The build MUST remain green and the in-flight working-tree improvements MUST be preserved.\n\nRead any files you need to get the instructions exactly right.\n\nCONFIRMED FINDINGS:\n${JSON.stringify(confirmed, null, 2)}`,
  { label: 'synthesize', phase: 'Synthesize', schema: BLUEPRINT_SCHEMA }
)

return {
  confirmedCount: confirmed.length,
  bySeverity: confirmed.reduce((a, f) => { a[f.severity] = (a[f.severity] || 0) + 1; return a }, {}),
  confirmed,
  blueprint,
}
