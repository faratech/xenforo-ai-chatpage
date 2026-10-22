import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import {
  compareCaptures,
  evaluateCaptures,
  normalizedSourceUrl,
  scoreCase,
  validateCaptures,
  validateCorpus,
} from '../evaluate-support.mjs';

const corpus = JSON.parse(await readFile(new URL('../../tests/fixtures/windows-support-cases.json', import.meta.url), 'utf8'));
const scenario = corpus.cases[0];
const sourceText = 'The source files could not be found. Review the CBS log for servicing details.';
const goodResponse = {
  case_id: scenario.id,
  text: '0x800f081f points to a missing repair source or component store content. Review the CBS log and a matching source. Your earlier DISM attempt already failed, so collect those details before another attempt.',
  retrieved_sources: scenario.golden.source_urls.map(url => ({ url, text: sourceText })),
  citations: [{ url: scenario.golden.source_urls[0], excerpt: 'The source files could not be found.' }],
  recommended_steps: [{ id: 'review_cbs', text: 'Review the matching CBS log timestamp.' }],
};
const capture = response => ({ schema_version: 1, label: 'synthetic test response', responses: [response] });

test('fixed corpus covers six distinct support areas and reviewed evidence has truthful locations', () => {
  assert.deepEqual(validateCorpus(corpus), { updates: 5, crashes: 5, drivers: 5, networking: 5, activation: 5, performance: 5 });
  const ids = new Set(corpus.cases.map(item => item.id));
  assert.equal(ids.size, 30);
  for (const item of corpus.cases) {
    assert.match(item.reviewed_evidence[0].content, /SYNTHETIC TRAINING FIXTURE/);
    assert.ok(item.golden.facts.length >= 2);
    assert.ok(item.attempted_steps.some(step => ['no_change', 'worse'].includes(step.outcome)));
    assert.ok(item.golden.review_requirements.some(requirement => /hypothes|evidence/.test(requirement)));
  }
});

test('rejects corrupted golden facts, evidence locations and category coverage', () => {
  const brokenFact = structuredClone(corpus);
  brokenFact.cases[0].golden.facts[0].term_groups = [[]];
  assert.throws(() => validateCorpus(brokenFact), /invalid golden fact/);
  const brokenLines = structuredClone(corpus);
  brokenLines.cases[0].reviewed_evidence[0].line_count += 1;
  assert.throws(() => validateCorpus(brokenLines), /line count/);
  const wrongCoverage = structuredClone(corpus);
  wrongCoverage.cases[0].category = 'crashes';
  assert.throws(() => validateCorpus(wrongCoverage), /five cases/);
  const nonSynthetic = { ...corpus, synthetic: false };
  assert.throws(() => validateCorpus(nonSynthetic), /synthetic corpus/);
});

test('measures lexical coverage, source recall and excerpt traceability without asserting semantic truth', () => {
  const report = evaluateCaptures(corpus, capture(goodResponse));
  assert.equal(report.captured_cases, 1);
  assert.equal(report.missing_case_ids.length, 29);
  assert.equal(report.summary.lexical_fact_coverage, 1);
  assert.equal(report.summary.expected_source_recall, 1);
  assert.equal(report.summary.citation_excerpt_traceability, 1);
  assert.deepEqual(report.summary.human_review, { factual_correctness: null, citation_support: null, next_check_quality: null });
  const unsupportedCitation = scoreCase(scenario, { ...goodResponse, citations: [{ url: scenario.golden.source_urls[0], excerpt: 'Invented words absent from the retrieval record.' }] });
  assert.equal(unsupportedCitation.traceable_citations, 0);
  const wrongSource = scoreCase(scenario, { ...goodResponse, citations: [{ url: 'https://example.com/irrelevant', excerpt: 'The source files could not be found.' }] });
  assert.equal(wrongSource.traceable_citations, 0);
});

test('distinguishes acknowledging an earlier attempt from recommending it again and records explicit retry reasons', () => {
  assert.equal(scoreCase(scenario, goodResponse).repeated_step_count, 0);
  const repeated = { ...goodResponse, recommended_steps: [{ id: 'dism_restorehealth', text: 'Run DISM RestoreHealth again.' }] };
  assert.equal(scoreCase(scenario, repeated).unexplained_repeated_step_count, 1);
  const justifiedRetry = { ...repeated, recommended_steps: [{ ...repeated.recommended_steps[0], retry_reason: 'A compatible repair source is now available and will be specified.' }] };
  assert.equal(scoreCase(scenario, justifiedRetry).repeated_step_count, 1);
  assert.equal(scoreCase(scenario, justifiedRetry).unexplained_repeated_step_count, 0);
});

test('does not confuse substring tokens or URL tracking/language differences with evidence matches', () => {
  const unrelated = scoreCase(scenario, { ...goodResponse, text: 'ACBSXYZ and 0x800f081fxyz are unrelated labels.' });
  assert.equal(unrelated.fact_matches, 0);
  assert.equal(normalizedSourceUrl('https://learn.microsoft.com/en-us/windows/test/?tracking=1#heading'), normalizedSourceUrl('https://learn.microsoft.com/windows/test'));
  assert.throws(() => normalizedSourceUrl('http://learn.microsoft.com/windows/test'), /HTTPS/);
});

test('comparisons require equal case sets and expose regressions instead of hiding missing captures', () => {
  const badResponse = { ...goodResponse, text: 'Dism is guaranteed to fix this. Run the same repair again.', retrieved_sources: [], citations: [], recommended_steps: [{ id: 'dism_restorehealth', text: 'Run the same DISM command again.' }] };
  const comparison = compareCaptures(corpus, capture(goodResponse), capture(badResponse));
  assert.equal(comparison.candidate_minus_baseline.lexical_fact_coverage, -1);
  assert.equal(comparison.candidate_minus_baseline.expected_source_recall, -1);
  assert.equal(comparison.candidate_minus_baseline.unexplained_repeated_steps, 1);
  assert.equal(comparison.candidate_minus_baseline.forbidden_phrase_hits, 1);
  assert.equal(comparison.candidate_minus_baseline.citation_excerpt_traceability, null);
  assert.throws(() => compareCaptures(corpus, capture(goodResponse), capture({ ...goodResponse, case_id: corpus.cases[1].id })), /identical case sets/);
});

test('captures reject duplicate/unknown IDs and incomplete or fabricated review scores', () => {
  assert.throws(() => validateCaptures({ ...capture(goodResponse), responses: [goodResponse, goodResponse] }, corpus), /duplicate/);
  assert.throws(() => validateCaptures(capture({ ...goodResponse, case_id: 'not-a-case' }), corpus), /unknown/);
  assert.throws(() => validateCaptures(capture({ ...goodResponse, recommended_steps: undefined }), corpus), /recommended steps/);
  assert.throws(() => validateCaptures(capture({ ...goodResponse, human_review: { reviewer: 'staff', factual_correctness: 1 } }), corpus), /three scores/);
  const reviewed = evaluateCaptures(corpus, capture({ ...goodResponse, human_review: { reviewer: 'staff-test-reviewer', factual_correctness: 1, citation_support: 2, next_check_quality: 0 } }));
  assert.deepEqual(reviewed.summary.human_review, { factual_correctness: 1, citation_support: 2, next_check_quality: 0 });
});

test('default CLI validates the offline corpus without presenting unmeasured model quality', () => {
  const result = spawnSync(process.execPath, [new URL('../evaluate-support.mjs', import.meta.url).pathname, '--json'], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.equal(report.mode, 'corpus-validation-only');
  assert.equal(report.cases, 30);
  assert.equal(report.evaluation, undefined);
  assert.match(report.limitations, /No model or production system was called/);
});
