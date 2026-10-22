#!/usr/bin/env node
/** Offline support evaluation. No provider, database, browser, or network calls. */
import { readFile } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { resolve } from 'node:path';

export const SUPPORT_CATEGORIES = ['updates', 'crashes', 'drivers', 'networking', 'activation', 'performance'];
const DEFAULT_CORPUS = fileURLToPath(new URL('../tests/fixtures/windows-support-cases.json', import.meta.url));
const HUMAN_DIMENSIONS = ['factual_correctness', 'citation_support', 'next_check_quality'];

const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const nonempty = value => typeof value === 'string' && value.trim().length > 0;
const requireValue = (condition, message) => { if (!condition) throw new Error(message); };
const stringList = value => Array.isArray(value) && value.length > 0 && value.every(nonempty);
const normalizedText = value => value.toLocaleLowerCase('en-US').normalize('NFKC').replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
const containsPhrase = (text, phrase) => ` ${text} `.includes(` ${normalizedText(phrase)} `);
const ratio = (numerator, denominator) => denominator ? numerator / denominator : null;

export const normalizedSourceUrl = value => {
  const url = new URL(value);
  requireValue(url.protocol === 'https:' && !url.username && !url.password, 'Sources must be public HTTPS URLs without credentials.');
  const path = url.pathname.replace(/^\/[a-z]{2}-[a-z]{2}\//i, '/').replace(/\/$/, '');
  return `${url.hostname.toLowerCase()}${path}`;
};

export const validateCorpus = corpus => {
  requireValue(record(corpus) && corpus.schema_version === 1 && corpus.synthetic === true, 'Expected synthetic corpus schema_version 1.');
  requireValue(Array.isArray(corpus.cases) && corpus.cases.length === 30, 'The fixed corpus must contain exactly 30 cases.');
  const seen = new Set();
  const coverage = Object.fromEntries(SUPPORT_CATEGORIES.map(category => [category, 0]));
  for (const item of corpus.cases) {
    requireValue(record(item) && nonempty(item.id) && !seen.has(item.id), 'Each case needs a unique nonempty id.');
    seen.add(item.id);
    requireValue(Object.hasOwn(coverage, item.category), `${item.id}: unknown category.`);
    coverage[item.category] += 1;
    requireValue(nonempty(item.prompt) && nonempty(item.title), `${item.id}: prompt/title missing.`);
    requireValue(record(item.profile) && ['os', 'version', 'build', 'device'].every(key => nonempty(item.profile[key])), `${item.id}: confirmed profile missing.`);
    requireValue(Array.isArray(item.reviewed_evidence) && item.reviewed_evidence.length > 0, `${item.id}: reviewed evidence missing.`);
    const evidenceIds = new Set();
    for (const evidence of item.reviewed_evidence) {
      requireValue(record(evidence) && nonempty(evidence.id) && !evidenceIds.has(evidence.id) && nonempty(evidence.content)
        && nonempty(evidence.name) && evidence.name.endsWith('.reviewed.txt')
        && evidence.line_count === evidence.content.split('\n').length, `${item.id}: invalid reviewed evidence or line count.`);
      evidenceIds.add(evidence.id);
    }
    requireValue(Array.isArray(item.attempted_steps) && item.attempted_steps.length > 0, `${item.id}: attempted steps missing.`);
    const attemptedIds = new Set();
    for (const step of item.attempted_steps) {
      requireValue(record(step) && nonempty(step.id) && !attemptedIds.has(step.id) && nonempty(step.description)
        && ['helped', 'no_change', 'worse', 'not_attempted'].includes(step.outcome), `${item.id}: invalid attempted step.`);
      attemptedIds.add(step.id);
    }
    const gold = item.golden;
    requireValue(record(gold) && Array.isArray(gold.facts) && gold.facts.length >= 2, `${item.id}: expected facts missing.`);
    const factIds = new Set();
    for (const fact of gold.facts) {
      requireValue(record(fact) && nonempty(fact.id) && !factIds.has(fact.id) && nonempty(fact.description)
        && Array.isArray(fact.term_groups) && fact.term_groups.length > 0 && fact.term_groups.every(stringList), `${item.id}: invalid golden fact.`);
      factIds.add(fact.id);
    }
    requireValue(stringList(gold.source_urls) && stringList(gold.review_requirements), `${item.id}: source/review targets missing.`);
    for (const url of gold.source_urls) {
      normalizedSourceUrl(url);
      requireValue(['learn.microsoft.com', 'support.microsoft.com', 'windowsforum.com'].includes(new URL(url).hostname), `${item.id}: unexpected source domain.`);
    }
    requireValue(stringList(gold.avoid_recommending_step_ids) && gold.avoid_recommending_step_ids.every(id => attemptedIds.has(id)), `${item.id}: repeated-step targets must reference attempted steps.`);
    requireValue(Array.isArray(gold.forbidden_claims) && gold.forbidden_claims.length > 0
      && gold.forbidden_claims.every(claim => record(claim) && nonempty(claim.description) && stringList(claim.phrases)), `${item.id}: forbidden-claim review checks missing.`);
  }
  requireValue(Object.values(coverage).every(count => count === 5), 'The corpus must contain five cases in each of the six categories.');
  return coverage;
};

export const validateCaptures = (capture, corpus) => {
  requireValue(record(capture) && capture.schema_version === 1 && nonempty(capture.label) && Array.isArray(capture.responses), 'Expected captures schema_version 1, label and responses array.');
  requireValue(capture.responses.length > 0, 'Captures must contain at least one response.');
  const caseIds = new Set(corpus.cases.map(item => item.id));
  const seen = new Set();
  for (const response of capture.responses) {
    requireValue(record(response) && caseIds.has(response.case_id) && !seen.has(response.case_id), 'Captured response has an unknown or duplicate case_id.');
    seen.add(response.case_id);
    requireValue(nonempty(response.text) && Array.isArray(response.retrieved_sources) && Array.isArray(response.citations)
      && Array.isArray(response.recommended_steps), `${response.case_id}: text, sources, citations and recommended steps are required.`);
    for (const source of response.retrieved_sources) {
      requireValue(record(source) && nonempty(source.url) && (source.text === undefined || typeof source.text === 'string'), `${response.case_id}: invalid retrieved source.`);
      normalizedSourceUrl(source.url);
    }
    for (const citation of response.citations) {
      requireValue(record(citation) && nonempty(citation.url) && (citation.excerpt === undefined || typeof citation.excerpt === 'string'), `${response.case_id}: invalid citation.`);
      normalizedSourceUrl(citation.url);
    }
    for (const step of response.recommended_steps) {
      requireValue(record(step) && nonempty(step.id) && nonempty(step.text)
        && (step.retry_reason === undefined || typeof step.retry_reason === 'string'), `${response.case_id}: invalid recommended step.`);
    }
    if (response.human_review !== undefined) {
      requireValue(record(response.human_review) && nonempty(response.human_review.reviewer)
        && HUMAN_DIMENSIONS.every(key => Number.isInteger(response.human_review[key]) && response.human_review[key] >= 0 && response.human_review[key] <= 2), `${response.case_id}: human review requires reviewer and three scores from 0 to 2.`);
    }
  }
  return capture;
};

/** Lexical/traceability proxies; they do not establish truth or semantic support. */
export const scoreCase = (item, response) => {
  const text = normalizedText(response.text);
  const facts = item.golden.facts.map(fact => ({
    id: fact.id,
    matched: fact.term_groups.every(group => group.some(phrase => containsPhrase(text, phrase))),
  }));
  const retrieved = new Set(response.retrieved_sources.map(source => normalizedSourceUrl(source.url)));
  const expected = new Set(item.golden.source_urls.map(normalizedSourceUrl));
  const retrievedTargets = [...expected].filter(url => retrieved.has(url));
  const traceableCitations = response.citations.filter(citation => nonempty(citation.excerpt)
    && citation.excerpt.trim().length >= 16 && response.retrieved_sources.some(source => normalizedSourceUrl(source.url) === normalizedSourceUrl(citation.url)
      && typeof source.text === 'string' && normalizedText(source.text).includes(normalizedText(citation.excerpt))));
  const forbiddenPhraseHits = item.golden.forbidden_claims.filter(claim => claim.phrases.some(phrase => containsPhrase(text, phrase))).map(claim => claim.description);
  const repeatedSteps = response.recommended_steps.filter(step => item.golden.avoid_recommending_step_ids.includes(step.id));
  return {
    case_id: item.id,
    category: item.category,
    facts,
    fact_matches: facts.filter(fact => fact.matched).length,
    fact_targets: facts.length,
    retrieved_source_matches: retrievedTargets.length,
    retrieved_source_targets: expected.size,
    traceable_citations: traceableCitations.length,
    citation_count: response.citations.length,
    repeated_step_count: repeatedSteps.length,
    unexplained_repeated_step_count: repeatedSteps.filter(step => !nonempty(step.retry_reason)).length,
    forbidden_phrase_hits: forbiddenPhraseHits,
    human_review: response.human_review ?? null,
  };
};

export const evaluateCaptures = (corpus, capture) => {
  validateCorpus(corpus);
  validateCaptures(capture, corpus);
  const byId = new Map(corpus.cases.map(item => [item.id, item]));
  const results = capture.responses.map(response => scoreCase(byId.get(response.case_id), response));
  const sum = key => results.reduce((total, result) => total + result[key], 0);
  const humanReviewed = results.filter(result => result.human_review !== null);
  return {
    label: capture.label,
    captured_cases: results.length,
    missing_case_ids: corpus.cases.filter(item => !results.some(result => result.case_id === item.id)).map(item => item.id),
    summary: {
      lexical_fact_coverage: ratio(sum('fact_matches'), sum('fact_targets')),
      expected_source_recall: ratio(sum('retrieved_source_matches'), sum('retrieved_source_targets')),
      citation_excerpt_traceability: ratio(sum('traceable_citations'), sum('citation_count')),
      repeated_steps: sum('repeated_step_count'),
      unexplained_repeated_steps: sum('unexplained_repeated_step_count'),
      forbidden_phrase_hits: results.reduce((total, result) => total + result.forbidden_phrase_hits.length, 0),
      human_reviewed_cases: humanReviewed.length,
      human_review: Object.fromEntries(HUMAN_DIMENSIONS.map(dimension => [dimension,
        humanReviewed.length ? humanReviewed.reduce((total, result) => total + result.human_review[dimension], 0) / humanReviewed.length : null])),
    },
    results,
  };
};

export const compareCaptures = (corpus, baseline, candidate) => {
  const before = evaluateCaptures(corpus, baseline);
  const after = evaluateCaptures(corpus, candidate);
  requireValue([...before.results.map(result => result.case_id)].sort().join('\n') === [...after.results.map(result => result.case_id)].sort().join('\n'), 'Compare captures with identical case sets; missing cases would bias the averages.');
  const deltas = Object.fromEntries(Object.entries(before.summary).filter(([, value]) => typeof value === 'number' || value === null).map(([key, value]) => [key,
    typeof value === 'number' && typeof after.summary[key] === 'number' ? after.summary[key] - value : null]));
  return { baseline: before, candidate: after, candidate_minus_baseline: deltas };
};

export const main = async args => {
  let corpusPath = DEFAULT_CORPUS;
  let responsePath;
  let comparePath;
  let json = false;
  for (let i = 0; i < args.length; i += 1) {
    const flag = args[i];
    if (flag === '--json') json = true;
    else if (['--corpus', '--responses', '--compare'].includes(flag)) {
      requireValue(nonempty(args[i + 1]) && !args[i + 1].startsWith('--'), `${flag} needs a JSON file path.`);
      const value = args[++i];
      if (flag === '--corpus') corpusPath = value;
      else if (flag === '--responses') responsePath = value;
      else comparePath = value;
    } else throw new Error(`Unknown argument: ${flag}`);
  }
  requireValue(!comparePath || responsePath, '--compare requires --responses for the baseline.');
  const readJson = async path => JSON.parse(await readFile(path, 'utf8'));
  const corpus = await readJson(corpusPath);
  const coverage = validateCorpus(corpus);
  const limitations = 'Offline lexical coverage and excerpt traceability are proxies, not proof of factual accuracy or citation support. Human review remains required. No model or production system was called.';
  let report = { mode: 'corpus-validation-only', cases: corpus.cases.length, coverage, limitations };
  if (responsePath) {
    const baseline = await readJson(responsePath);
    report = { mode: comparePath ? 'captured-response-comparison' : 'captured-response-evaluation', limitations,
      ...(comparePath ? compareCaptures(corpus, baseline, await readJson(comparePath)) : { evaluation: evaluateCaptures(corpus, baseline) }) };
  }
  if (json) process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  else {
    process.stdout.write(`${report.mode}: ${corpus.cases.length} corpus cases\n${limitations}\n`);
    if (responsePath) process.stdout.write(`${JSON.stringify(report.candidate_minus_baseline ?? report.evaluation.summary, null, 2)}\n`);
    else process.stdout.write(`${JSON.stringify(coverage)}\n`);
  }
  return report;
};

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main(process.argv.slice(2)).catch(error => {
    process.stderr.write(`Support evaluation failed: ${error.message}\n`);
    process.exitCode = 1;
  });
}
