# Upstream techniques and support evaluation

This implementation adapts interaction and protocol techniques to WindowsForum's existing React/MUI, XenForo/PHP and FastAPI application. It does not embed another chat application or copy upstream source files. The implementations and tests in this change are original project code; the following references describe design provenance, not a claim of byte-for-byte reuse.

## Pinned references

Reference snapshots and their root licenses were checked against the GitHub commit API and raw LICENSE files on 2026-10-22. The approved plan supplied the Anthropic and llama.cpp commit IDs; the OpenAI repositories were pinned while implementing that plan.

| Upstream | Snapshot and source | License / copyright | Adapted technique |
| --- | --- | --- | --- |
| OpenAI ChatKit advanced samples | [`9729a1c05411f10bd02c2a0780b23c443d5415d6`](https://github.com/openai/openai-chatkit-advanced-samples/tree/9729a1c05411f10bd02c2a0780b23c443d5415d6) | [MIT](https://github.com/openai/openai-chatkit-advanced-samples/blob/9729a1c05411f10bd02c2a0780b23c443d5415d6/LICENSE), Copyright 2025 OpenAI | Contextual customer profile/timeline, typed support cards and inspectable source navigation. |
| OpenAI Responses starter app | [`0fae283f12ca3f71015cd9fa3f9b28df97e9ae21`](https://github.com/openai/openai-responses-starter-app/tree/0fae283f12ca3f71015cd9fa3f9b28df97e9ae21) | [MIT](https://github.com/openai/openai-responses-starter-app/blob/0fae283f12ca3f71015cd9fa3f9b28df97e9ae21/LICENSE), Copyright 2025 OpenAI | Separate messages, tool activity and annotations while preserving the application's terminal SSE event. |
| Anthropic customer support quickstart | [`9ec32b91df50b0d4906cae64b13c6298055ff40d/customer-support-agent`](https://github.com/anthropics/claude-quickstarts/tree/9ec32b91df50b0d4906cae64b13c6298055ff40d/customer-support-agent) | [MIT](https://github.com/anthropics/claude-quickstarts/blob/9ec32b91df50b0d4906cae64b13c6298055ff40d/LICENSE), Copyright (c) 2023 Anthropic | User-inspectable source details and contextual support interactions. No debug payloads or legacy parsing logic are imported. |
| llama.cpp interface | [`a37cc46104eb50900d5ab4a9ba02a0abdac039db/tools/ui`](https://github.com/ggml-org/llama.cpp/tree/a37cc46104eb50900d5ab4a9ba02a0abdac039db/tools/ui), including [branching utilities](https://github.com/ggml-org/llama.cpp/blob/a37cc46104eb50900d5ab4a9ba02a0abdac039db/tools/ui/src/lib/utils/branching.ts) | [MIT](https://github.com/ggml-org/llama.cpp/blob/a37cc46104eb50900d5ab4a9ba02a0abdac039db/LICENSE), Copyright (c) 2023–2026 The ggml authors | Alternate-answer navigation, reviewed attachments and visibility into included context. Branches use WindowsForum conversations rather than llama.cpp's Svelte/store implementation. |

If a later change imports or adapts substantial upstream code, record the source path and commit, retain the applicable copyright and full permission notice alongside that code, and port its relevant tests. These design references do not replace the upstream license requirements for a future code import.

## Reviewed diagnostic files

With the server-advertised diagnostic capability enabled, text uploads are decoded locally, reviewed and explicitly approved before uploading. UTF-8 and BOM-marked UTF-16LE/BE are supported. LOG, XML and textual NFO join the existing text formats. XML remains inert text. Binary files and malformed encodings are rejected.

The reviewed UTF-8 derivative is named `<original-name>.reviewed.txt`. Numbered preview lines refer to that derivative after edits and redactions. Original bytes stay local during review. Suggested redactions require an explicit action, can miss private information, and must be checked by the user. Excluded or oversized content is identified; content is never silently truncated. Existing attachments count toward the server-provided per-turn count and text/image byte limits. Cancelling review preserves existing uploaded handles.

## Offline Windows support evaluation

Run `node scripts/evaluate-support.mjs` to validate the fixed 30-case corpus. This default checks five synthetic scenarios each for updates, crashes, drivers, networking, activation and performance. It calls no model, database, service or network endpoint and makes no claim about response quality.

The corpus contains synthetic reviewed diagnostic text, confirmed PC facts, attempted steps with outcomes, expected fact terms, relevant official documentation URLs, prohibited-claim review checks, and human review requirements. Source targets were checked on 2026-10-22 using the Microsoft Docs skill and official Microsoft documentation; URLs were verified as reachable. They are retrieval targets, not a promise that every document applies to every future Windows build. The fixtures deliberately use a fixed Windows 11 24H2 context and never describe the newest release as a fact.

To compare actual, separately captured responses:

```sh
node scripts/evaluate-support.mjs --responses baseline.json --compare candidate.json --json
```

Captures must have identical case sets for comparison. Partial captures are accepted for individual evaluation and list every missing case; they cannot appear as a complete 30-case run. Capture files must be reviewed for privacy before storing them. An example capture shape, with synthetic response text, is:

```json
{
  "schema_version": 1,
  "label": "staff staging capture",
  "responses": [
    {
      "case_id": "updates-01-missing-source",
      "text": "0x800f081f concerns missing source/component-store content. Review the CBS log and a matching repair source before retrying the earlier failed DISM attempt.",
      "retrieved_sources": [
        {
          "url": "https://learn.microsoft.com/troubleshoot/windows-client/installing-updates-features-roles/common-windows-update-errors",
          "text": "A synthetic retrieval excerpt for demonstration."
        }
      ],
      "citations": [
        {
          "url": "https://learn.microsoft.com/troubleshoot/windows-client/installing-updates-features-roles/common-windows-update-errors",
          "excerpt": "A synthetic retrieval excerpt for demonstration."
        }
      ],
      "recommended_steps": [
        { "id": "review_cbs", "text": "Inspect the servicing log at the matching timestamp." }
      ],
      "human_review": {
        "reviewer": "staff reviewer identifier",
        "factual_correctness": 2,
        "citation_support": 1,
        "next_check_quality": 2
      }
    }
  ]
}
```

Record actual retrieval text and citation excerpts; do not substitute the demonstration excerpt above. `recommended_steps` captures new recommended actions, not every command mentioned in an answer. Repeated actions use the stable attempted-step ID from the scenario. An optional `retry_reason` explains the changed condition; the report still counts the action as repeated and separately counts repetitions without an explanation.

The deterministic report measures **lexical fact coverage**, expected-source recall, and whether citation excerpts can be traced to a captured retrieval record. It also surfaces repeated-step counts and prohibited-phrase hits. These are review signals: a word match can appear in a wrong statement, a correct paraphrase can miss the lexical target, a prohibited phrase can be quoted in a refusal, and excerpt presence does not establish that a claim is supported. There is intentionally no overall pass score or automatic factual-correctness assertion.

Staff must inspect each answer against the golden facts, source excerpts, OS/build and recorded outcomes. Optional human scores use 0 = incorrect/unsupported, 1 = partially correct/supported, and 2 = correct/supported for factual correctness, citation support and next-check quality. Unreviewed cases have null human scores. Compare cost and latency only from separately measured provider telemetry; this runner does not synthesize either measurement.
