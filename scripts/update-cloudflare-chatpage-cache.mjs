#!/usr/bin/env node

/**
 * Guarded Cloudflare Cache Rules correction for /chatpage assets.
 *
 * Dry-run is the default. Apply mode requires the exact ruleset/rule versions
 * and expression digests printed by dry-run, writes a credential-free rollback
 * record, patches only the two named rules, and verifies the live result.
 */

import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

const API = 'https://api.cloudflare.com/client/v4';
const PHASE = 'http_request_cache_settings';
const CHAT_DESCRIPTION = 'No cache on chat';
const MEDIA_DESCRIPTION = 'Cache XenForo media attachments';
const CHAT_CLAUSE = '(http.request.uri.path contains "/chatpage")';
const CHAT_ASSET_CLAUSE = '((http.request.uri.path contains "/chatpage") and not ((http.request.uri.path in {"/chatpage/" "/chatpage/index.html" "/chatpage/manifest.json" "/chatpage/bot-avatar.webp"}) or starts_with(http.request.uri.path, "/chatpage/static/")))';
const AVATAR_EXCLUSION = ' and not ((http.host eq "windowsforum.com") and (http.request.uri.path eq "/chatpage/bot-avatar.webp"))';
const MUTABLE_FIELDS = [
  'action',
  'action_parameters',
  'description',
  'enabled',
  'exposed_credential_check',
  'expression',
  'logging',
  'ratelimit',
  'ref',
];

const digest = value => createHash('sha256').update(value).digest('hex');

const replaceExactlyOnce = (source, from, to) => {
  const first = source.indexOf(from);
  if (first === -1 || source.indexOf(from, first + from.length) !== -1) {
    throw new Error(`expected exactly one occurrence of ${from}`);
  }
  return source.slice(0, first) + to + source.slice(first + from.length);
};

export const proposedChatExpression = expression => {
  if (expression.includes(CHAT_ASSET_CLAUSE)) return expression;
  return replaceExactlyOnce(expression, CHAT_CLAUSE, CHAT_ASSET_CLAUSE);
};

export const proposedMediaExpression = expression => {
  if (expression.endsWith(AVATAR_EXCLUSION)) return expression;
  return `(${expression})${AVATAR_EXCLUSION}`;
};

const parseArgs = args => {
  const parsed = {
    apply: false,
    envFile: '/web/.env',
    artifactRoot: '/web/ops/backups/cloudflare-chatpage-cache',
  };
  for (let index = 0; index < args.length; index += 1) {
    const value = args[index];
    if (value === '--apply') parsed.apply = true;
    else if (value.startsWith('--')) {
      const key = value.slice(2).replace(/-([a-z])/g, (_match, letter) => letter.toUpperCase());
      const next = args[index + 1];
      if (!next || next.startsWith('--')) throw new Error(`${value} requires a value`);
      parsed[key] = next;
      index += 1;
    } else {
      throw new Error(`unexpected argument: ${value}`);
    }
  }
  const required = [
    'expectedRulesetVersion',
    'expectedChatRuleVersion',
    'expectedMediaRuleVersion',
    'expectedChatSha',
    'expectedMediaSha',
  ];
  if (parsed.apply) {
    const missing = required.filter(key => !parsed[key]);
    if (missing.length) throw new Error(`apply requires: ${missing.join(', ')}`);
  }
  return parsed;
};

const loadEnv = async envFile => {
  const values = {};
  for (const rawLine of (await readFile(envFile, 'utf8')).split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const separator = line.indexOf('=');
    if (separator <= 0) continue;
    const key = line.slice(0, separator).trim();
    let value = line.slice(separator + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    values[key] = value;
  }
  return values;
};

class CloudflareClient {
  constructor(env) {
    this.zoneId = env.CLOUDFLARE_ZONE_ID;
    if (!this.zoneId) throw new Error('CLOUDFLARE_ZONE_ID is missing');
    if (env.CLOUDFLARE_EMAIL && env.CLOUDFLARE_GLOBAL_TOKEN) {
      this.headers = {
        'X-Auth-Email': env.CLOUDFLARE_EMAIL,
        'X-Auth-Key': env.CLOUDFLARE_GLOBAL_TOKEN,
      };
    } else if (env.CLOUDFLARE_API_TOKEN) {
      this.headers = { Authorization: `Bearer ${env.CLOUDFLARE_API_TOKEN}` };
    } else {
      throw new Error('Cloudflare Cache Rules credentials are missing');
    }
  }

  async request(method, endpoint, body) {
    const response = await fetch(`${API}${endpoint}`, {
      method,
      headers: { ...this.headers, 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    let payload;
    try {
      payload = await response.json();
    } catch {
      throw new Error(`Cloudflare returned non-JSON HTTP ${response.status}`);
    }
    if (!response.ok || payload.success !== true) {
      const errors = Array.isArray(payload.errors)
        ? payload.errors.slice(0, 3).map(error => ({ code: error.code, message: error.message }))
        : [];
      throw new Error(`Cloudflare ${method} failed with HTTP ${response.status}: ${JSON.stringify(errors)}`);
    }
    return payload.result;
  }

  getRuleset() {
    return this.request('GET', `/zones/${this.zoneId}/rulesets/phases/${PHASE}/entrypoint`);
  }

  patchRule(rulesetId, ruleId, payload) {
    return this.request('PATCH', `/zones/${this.zoneId}/rulesets/${rulesetId}/rules/${ruleId}`, payload);
  }
}

const findRule = (ruleset, description) => {
  const matches = ruleset.rules.filter(rule => rule.description === description);
  if (matches.length !== 1) throw new Error(`expected one rule named ${description}; found ${matches.length}`);
  return matches[0];
};

const mutablePayload = (rule, expression = rule.expression) => {
  const payload = {};
  for (const field of MUTABLE_FIELDS) {
    if (Object.hasOwn(rule, field)) payload[field] = rule[field];
  }
  payload.expression = expression;
  return payload;
};

const assertGuard = (actual, expected, label) => {
  if (String(actual) !== String(expected)) {
    throw new Error(`${label} guard changed: expected ${expected}, observed ${actual}`);
  }
};

const writeRollback = async (ruleset, chatRule, mediaRule, artifactRoot) => {
  await mkdir(artifactRoot, { mode: 0o700, recursive: true });
  const timestamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
  const artifactPath = path.join(artifactRoot, `${timestamp}-rollback.json`);
  const record = {
    captured_at: new Date().toISOString(),
    contains_credentials: false,
    phase: PHASE,
    ruleset: { id: ruleset.id, version: ruleset.version },
    rules: [chatRule, mediaRule].map(rule => ({
      id: rule.id,
      version: rule.version,
      description: rule.description,
      expression_sha256: digest(rule.expression),
      restore_payload: mutablePayload(rule),
    })),
    schema_version: 1,
  };
  await writeFile(artifactPath, `${JSON.stringify(record, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
  return artifactPath;
};

const main = async () => {
  const args = parseArgs(process.argv.slice(2));
  const client = new CloudflareClient(await loadEnv(args.envFile));
  const ruleset = await client.getRuleset();
  const chatRule = findRule(ruleset, CHAT_DESCRIPTION);
  const mediaRule = findRule(ruleset, MEDIA_DESCRIPTION);
  const chatExpression = proposedChatExpression(chatRule.expression);
  const mediaExpression = proposedMediaExpression(mediaRule.expression);

  const report = {
    ruleset_id: ruleset.id,
    ruleset_version: ruleset.version,
    chat_rule: {
      id: chatRule.id,
      version: chatRule.version,
      current_sha256: digest(chatRule.expression),
      proposed_sha256: digest(chatExpression),
      change_required: chatExpression !== chatRule.expression,
    },
    media_rule: {
      id: mediaRule.id,
      version: mediaRule.version,
      current_sha256: digest(mediaRule.expression),
      proposed_sha256: digest(mediaExpression),
      change_required: mediaExpression !== mediaRule.expression,
    },
  };

  if (!args.apply) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    process.stdout.write('\nGuarded apply command:\n');
    process.stdout.write([
      'node scripts/update-cloudflare-chatpage-cache.mjs --apply',
      `--expected-ruleset-version ${ruleset.version}`,
      `--expected-chat-rule-version ${chatRule.version}`,
      `--expected-media-rule-version ${mediaRule.version}`,
      `--expected-chat-sha ${digest(chatRule.expression)}`,
      `--expected-media-sha ${digest(mediaRule.expression)}`,
    ].join(' ') + '\n');
    return;
  }

  assertGuard(ruleset.version, args.expectedRulesetVersion, 'ruleset version');
  assertGuard(chatRule.version, args.expectedChatRuleVersion, 'chat rule version');
  assertGuard(mediaRule.version, args.expectedMediaRuleVersion, 'media rule version');
  assertGuard(digest(chatRule.expression), args.expectedChatSha, 'chat expression SHA-256');
  assertGuard(digest(mediaRule.expression), args.expectedMediaSha, 'media expression SHA-256');

  if (chatExpression === chatRule.expression && mediaExpression === mediaRule.expression) {
    process.stdout.write('Cloudflare chatpage cache rules are already compliant.\n');
    return;
  }

  const artifactPath = await writeRollback(ruleset, chatRule, mediaRule, args.artifactRoot);
  const applied = [];
  try {
    if (chatExpression !== chatRule.expression) {
      await client.patchRule(ruleset.id, chatRule.id, mutablePayload(chatRule, chatExpression));
      applied.push(chatRule);
    }
    if (mediaExpression !== mediaRule.expression) {
      await client.patchRule(ruleset.id, mediaRule.id, mutablePayload(mediaRule, mediaExpression));
      applied.push(mediaRule);
    }

    const verified = await client.getRuleset();
    assertGuard(findRule(verified, CHAT_DESCRIPTION).expression, chatExpression, 'verified chat expression');
    assertGuard(findRule(verified, MEDIA_DESCRIPTION).expression, mediaExpression, 'verified media expression');
    process.stdout.write(`Cloudflare chatpage cache rules applied and verified. Rollback: ${artifactPath}\n`);
  } catch (error) {
    const rollbackErrors = [];
    for (const rule of applied.reverse()) {
      try {
        await client.patchRule(ruleset.id, rule.id, mutablePayload(rule));
      } catch (rollbackError) {
        rollbackErrors.push(rollbackError instanceof Error ? rollbackError.message : String(rollbackError));
      }
    }
    if (rollbackErrors.length) {
      throw new Error(
        `${error instanceof Error ? error.message : error}; rollback failed: ${rollbackErrors.join('; ')}; artifact: ${artifactPath}`,
        { cause: error },
      );
    }
    throw new Error(
      `${error instanceof Error ? error.message : error}; applied rules were rolled back; artifact: ${artifactPath}`,
      { cause: error },
    );
  }
};

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch(error => {
    process.stderr.write(`cloudflare chatpage cache update failed: ${error instanceof Error ? error.message : error}\n`);
    process.exitCode = 1;
  });
}
