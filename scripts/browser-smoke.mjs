#!/usr/bin/env node
/* global document -- page.evaluate() callbacks run in the browser context;
   everything else in this file is Node. */

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { createServer } from 'node:https';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const here = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(here, '..');
const distRoot = path.join(projectRoot, 'dist');
const require = createRequire(import.meta.url);
const axePath = require.resolve('axe-core/axe.min.js');
const identityId = '1'.repeat(64);
const scenarios = new Map();

const executableCandidates = [
  process.env.WF_CHROME_PATH,
  '/usr/bin/google-chrome',
  '/usr/bin/google-chrome-stable',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
].filter(Boolean);
const executablePath = executableCandidates.find(candidate => existsSync(candidate));
assert(executablePath, 'No system Chrome/Chromium executable was found. Set WF_CHROME_PATH.');

let certPath = process.env.WF_BROWSER_SMOKE_CERT
  || '/etc/letsencrypt/live/windowsforum.com/fullchain.pem';
let keyPath = process.env.WF_BROWSER_SMOKE_KEY
  || '/etc/letsencrypt/live/windowsforum.com/privkey.pem';
let temporaryTlsDirectory = null;
if (!existsSync(certPath) || !existsSync(keyPath)) {
  temporaryTlsDirectory = await mkdtemp(path.join(os.tmpdir(), 'wf-chat-browser-smoke-'));
  certPath = path.join(temporaryTlsDirectory, 'cert.pem');
  keyPath = path.join(temporaryTlsDirectory, 'key.pem');
  execFileSync('openssl', [
    'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1',
    '-subj', '/CN=127.0.0.1',
    '-keyout', keyPath,
    '-out', certPath,
  ], { stdio: 'ignore' });
}

const json = (response, status, body, request) => {
  const origin = request.headers.origin;
  response.writeHead(status, {
    'access-control-allow-credentials': 'true',
    'access-control-allow-origin': origin || '*',
    'cache-control': 'no-store',
    'content-type': 'application/json; charset=utf-8',
  });
  response.end(JSON.stringify(body));
};

const streamAnswer = async (request, response, state, { slow = false } = {}) => {
  const origin = request.headers.origin;
  response.writeHead(200, {
    'access-control-allow-credentials': 'true',
    'access-control-allow-origin': origin || '*',
    'cache-control': 'no-store',
    'content-type': 'text/event-stream; charset=utf-8',
    'x-accel-buffering': 'no',
  });
  if (state.mode === 'desktop-screenshot') {
    const emit = event => response.write(`data: ${JSON.stringify(event)}\n\n`);
    const item = { id: 'desktop_1', type: 'function_call', name: 'windows_computer_task' };
    emit({ type: 'response.output_item.added', item });
    emit({ type: 'response.output_item.done', item });
    emit({ type: 'response.completed' });
    emit({ type: 'response.output_text.delta', delta: 'Desktop captured.\n\n![Desktop](https://data.windowsforum.com/images/ai/w365-tasks/browser-exact.png)' });
    emit({ type: 'chat.stream.completed' });
    response.end();
    return;
  }
  if (state.mode === 'guided-support') {
    const payload = state.chatPayloads[state.chatPayloads.length - 1];
    const emit = event => response.write(`data: ${JSON.stringify(event)}\n\n`);
    emit({ type: 'chat.context', context: {
      mode: 'troubleshoot', case_id: payload.support_case_id, case_revision: payload.support_case_revision,
      included_attachment_ids: [], history_items: payload.history?.length ?? 0, history_limit: 12,
      history_item_bytes: 2048, recovery_used: false,
    } });
    emit({ type: 'chat.activity', activity: { id: 'support_search', label: 'Reviewing support documentation', state: 'active' } });
    emit({ type: 'chat.evidence', evidence: [{
      id: 'ms_storage', kind: 'microsoft', title: 'Synthetic Microsoft source record',
      url: 'https://learn.microsoft.com/windows/deployment/update/windows-update-logs',
      excerpt: 'Synthetic retrieval excerpt: inspect available storage before retrying.', retrieved_at: '2026-10-22T12:00:00Z',
    }] });
    emit({ type: 'chat.support_card', card: {
      id: 'check_free_space', check: 'Inspect available storage',
      explanation: 'Review the system volume before retrying the update.',
      expected_result: 'Record the free space without deleting files.', evidence_ids: ['ms_storage'], command: 'Get-Volume',
    } });
    emit({ type: 'chat.activity', activity: { id: 'support_search', label: 'Reviewing support documentation', state: 'done' } });
    emit({ type: 'response.output_text.delta', delta: state.chatPayloads.length === 1 ? 'Guided support original answer.' : 'Guided support alternate answer.' });
    emit({ type: 'chat.stream.completed', response_id: `resp_guided_${state.chatPayloads.length}` });
    response.end();
    return;
  }
  response.write('data: {"type":"response.output_text.delta","delta":"Browser smoke"}\n\n');

  if (slow) {
    await new Promise(resolve => {
      const timer = setTimeout(resolve, 5_000);
      const stopped = () => {
        clearTimeout(timer);
        state.streamAborted = true;
        resolve();
      };
      request.once('aborted', stopped);
      response.once('close', stopped);
    });
    if (state.streamAborted || response.destroyed) return;
  }

  response.write('data: {"type":"response.output_text.delta","delta":" reply"}\n\n');
  response.end('data: {"type":"chat.stream.completed","response_id":"resp_browser_smoke"}\n\n');
};

const mime = new Map([
  ['.css', 'text/css; charset=utf-8'],
  ['.html', 'text/html; charset=utf-8'],
  ['.js', 'text/javascript; charset=utf-8'],
  ['.json', 'application/json; charset=utf-8'],
  ['.png', 'image/png'],
  ['.svg', 'image/svg+xml'],
  ['.webp', 'image/webp'],
  ['.woff2', 'font/woff2'],
]);

const server = createServer({
  cert: await readFile(certPath),
  key: await readFile(keyPath),
}, async (request, response) => {
  const requestUrl = new URL(request.url || '/', 'https://browser-smoke.invalid');
  const scenarioName = String(request.headers['x-wf-smoke-scenario'] || 'unscoped');
  const state = scenarios.get(scenarioName);

  if (request.method === 'OPTIONS') {
    response.writeHead(204, {
      'access-control-allow-credentials': 'true',
      'access-control-allow-headers': 'content-type,x-wf-turn-id',
      'access-control-allow-methods': 'GET,HEAD,POST,OPTIONS',
      'access-control-allow-origin': request.headers.origin || '*',
      'access-control-max-age': '60',
    });
    response.end();
    return;
  }

  if (requestUrl.pathname === '/chat.php' && request.method === 'POST') {
    if (!state) {
      // A throw inside this async handler escapes as an unhandled rejection,
      // killing the whole smoke run without saying which scenario broke.
      console.error(`[smoke] API request arrived without a known smoke scenario: ${scenarioName}`);
      response.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' });
      response.end(`unknown smoke scenario: ${scenarioName}`);
      return;
    }
    let body = '';
    for await (const chunk of request) body += chunk;
    const payload = JSON.parse(body || '{}');
    state.apiPayloads.push(payload);

    if (payload.action === 'getUserData') {
      state.identityCalls += 1;
      json(response, 200, {
        avatar: 'data:image/svg+xml,%3Csvg xmlns=%22http://www.w3.org/2000/svg%22/%3E',
        identity_id: identityId,
        name: 'Browser Smoke',
        user_id: '42',
        ...(state.mode === 'guided-support' ? { csrf_token: 'synthetic-browser-csrf-token' } : {}),
      }, request);
      return;
    }
    if (payload.action === 'getChatCapabilities') {
      const enabled = state.mode === 'guided-support';
      json(response, 200, {
        success: true, version: 1, modes: enabled ? ['chat', 'troubleshoot'] : ['chat'],
        features: { guided_support: enabled, diagnostics: enabled, branches: enabled, support_cards: enabled },
        limits: { max_attachments: 4, max_image_bytes: 8388608, max_text_file_bytes: 1048576, max_total_text_bytes: 131072, max_total_image_bytes: 10485760 },
      }, request);
      return;
    }
    if (state.mode === 'guided-support') {
      if (payload.action === 'listSupportCases') {
        json(response, 200, { success: true, cases: [...state.supportCases.values()], next_cursor: null }, request);
        return;
      }
      if (payload.action === 'getSupportCase') {
        const supportCase = state.supportCases.get(payload.case_id);
        json(response, supportCase ? 200 : 404, supportCase ? { success: true, case: supportCase } : { error: 'not_found' }, request);
        return;
      }
      if (payload.action === 'upsertSupportCase') {
        const now = Date.now();
        const supportCase = {
          ...payload.case, id: payload.case.id || 'case_browser_created', status: 'open', revision: 1,
          conversation_ids: [], attachment_ids: [], created_at: now, updated_at: now,
          progress: { confirmed_facts: [], recent_changes: '', attempts: [] },
        };
        state.supportCases.set(supportCase.id, supportCase);
        json(response, 200, { success: true, case: supportCase }, request);
        return;
      }
      if (payload.action === 'updateSupportCaseProgress') {
        const prior = state.supportCases.get(payload.case_id);
        if (!prior || prior.revision !== payload.expected_revision) {
          json(response, 409, { error: 'revision_conflict' }, request);
          return;
        }
        const supportCase = { ...prior, progress: payload.progress, revision: prior.revision + 1, updated_at: Date.now() };
        state.supportCases.set(supportCase.id, supportCase);
        json(response, 200, { success: true, case: supportCase }, request);
        return;
      }
      if (payload.action === 'listSavedConversations') {
        const summaries = [...state.savedConversations.values()].map(conversation => {
          const summary = { ...conversation };
          delete summary.messages;
          return summary;
        });
        json(response, 200, { success: true, conversations: summaries, next_cursor: null }, request);
        return;
      }
      if (payload.action === 'upsertSavedConversation') {
        const prior = state.savedConversations.get(payload.conversation.id);
        if ((prior?.revision ?? 0) !== payload.expected_revision) {
          json(response, 409, { error: 'revision_conflict' }, request);
          return;
        }
        const supportCase = state.supportCases.get(payload.conversation.support_case_id);
        const saved = {
          ...prior, ...payload.conversation, revision: (prior?.revision ?? 0) + 1, metadata_revision: 1,
          pinned_at: null, archived_at: null, created_at: prior?.created_at ?? Date.now(), updated_at: Date.now(),
          message_count: payload.conversation.messages.length,
          ...(supportCase ? { support_case_revision: supportCase.revision } : {}),
        };
        state.savedConversations.set(saved.id, structuredClone(saved));
        json(response, 200, { success: true, conversation: saved }, request);
        return;
      }
      if (payload.action === 'getSavedConversation') {
        const saved = state.savedConversations.get(payload.client_conversation_id);
        json(response, saved ? 200 : 404, saved ? { success: true, conversation: saved } : { error: 'not_found' }, request);
        return;
      }
      if (payload.action === 'forkConversation') {
        const source = state.savedConversations.get(payload.source_conversation_id);
        const index = source?.messages.findIndex(message => message.id === payload.fork_message_id) ?? -1;
        if (!source || source.revision !== payload.expected_revision || index < 0) {
          json(response, 409, { error: 'revision_conflict' }, request);
          return;
        }
        state.sourceTranscriptAtFork = structuredClone(source.messages);
        const fork = {
          ...structuredClone(source), id: 'conv_browser_fork', title: `Branch of ${source.title}`, revision: 1,
          created_at: Date.now(), updated_at: Date.now(),
          messages: structuredClone(source.messages.slice(0, index + (payload.kind === 'branch' ? 1 : 0))),
          lineage: { parent_conversation_id: source.id, fork_message_id: payload.fork_message_id, family_id: source.lineage?.family_id ?? source.id },
        };
        fork.message_count = fork.messages.length;
        state.savedConversations.set(fork.id, fork);
        json(response, 200, { success: true, conversation: fork, attachments: [] }, request);
        return;
      }
    }
    if (payload.action === 'getUsage') {
      json(response, 200, { logged_in: true, remaining: 10, used: 0, limit: 10 }, request);
      return;
    }
    if (payload.action === 'clientTelemetry') {
      state.telemetry.push(payload);
      json(response, 200, { success: true }, request);
      return;
    }
    if (payload.action === 'clearConversation' || payload.action === 'deleteConversation') {
      json(response, 200, { success: true }, request);
      return;
    }

    state.chatPayloads.push(payload);
    if (state.mode === 'captcha' && state.chatPayloads.length === 1) {
      json(response, 403, { captcha_required: true, error: 'captcha_required' }, request);
      return;
    }
    await streamAnswer(request, response, state, { slow: state.mode === 'abort' });
    return;
  }

  if (requestUrl.pathname === '/tts.php') {
    response.writeHead(204, { 'cache-control': 'no-store' });
    response.end();
    return;
  }

  let relative = requestUrl.pathname.startsWith('/chatpage/')
    ? requestUrl.pathname.slice('/chatpage/'.length)
    : '';
  if (!relative) relative = 'index.html';
  const filePath = path.resolve(distRoot, relative);
  if (!filePath.startsWith(`${distRoot}${path.sep}`)) {
    response.writeHead(403);
    response.end();
    return;
  }

  try {
    const fileStat = await stat(filePath);
    if (!fileStat.isFile()) throw new Error('not a file');
    const headers = {
      'cache-control': 'no-store',
      'content-type': mime.get(path.extname(filePath)) || 'application/octet-stream',
    };
    if (requestUrl.pathname === '/chatpage/service-worker.js') {
      headers['service-worker-allowed'] = '/pages/ai/';
    }
    response.writeHead(200, headers);
    response.end(await readFile(filePath));
  } catch {
    response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    response.end('not found');
  }
});

await new Promise((resolve, reject) => {
  server.once('error', reject);
  server.listen(0, '127.0.0.1', resolve);
});
const address = server.address();
assert(address && typeof address === 'object');
const origin = `https://127.0.0.1:${address.port}`;

const browser = await chromium.launch({
  executablePath,
  headless: true,
  args: ['--disable-dev-shm-usage', '--ignore-certificate-errors', '--no-sandbox'],
});

const createPage = async (
  name,
  mode,
  {
    failChatChunk = false,
    failPreferencesChunkOnce = false,
    blockServiceWorkers = false,
    viewport,
  } = {},
) => {
  const state = {
    apiPayloads: [],
    chatPayloads: [],
    identityCalls: 0,
    mode,
    optionalChunkFailures: 0,
    optionalChunkRequests: 0,
    streamAborted: false,
    telemetry: [],
    supportCases: new Map([['case_browser_existing', {
      id: 'case_browser_existing', title: 'Existing synthetic update case', description: 'A synthetic update error for browser coverage.',
      status: 'open', revision: 3, pc_profile: { os_name: 'Windows', os_version: 'Windows 11 24H2', build: '26100.1000' },
      conversation_ids: [], attachment_ids: [], created_at: Date.now(), updated_at: Date.now(),
      progress: { confirmed_facts: ['Synthetic PC has limited free storage.'], recent_changes: 'A synthetic update was attempted.', attempts: [] },
    }]]),
    savedConversations: new Map(),
  };
  scenarios.set(name, state);
  const context = await browser.newContext({
    ignoreHTTPSErrors: true,
    serviceWorkers: blockServiceWorkers ? 'block' : 'allow',
    ...(viewport ? { viewport } : {}),
  });
  const page = await context.newPage();
  if (mode === 'guided-support') {
    // These scenarios exercise real rendered code with mocked application APIs.
    // Unexpected external requests must never escape to a live provider/site.
    await page.route('**/*', route => new URL(route.request().url()).hostname === '127.0.0.1'
      ? route.continue() : route.abort('blockedbyclient'));
  }
  const routeApi = async route => {
    const request = route.request();
    const headers = { ...request.headers(), 'x-wf-smoke-scenario': name };
    const url = new URL(request.url());
    if (url.hostname === 'windowsforum.com') {
      url.protocol = 'https:';
      url.hostname = '127.0.0.1';
      url.port = String(address.port);
    }
    await route.continue({ headers, url: url.toString() });
  };
  await page.route('**/chat.php', routeApi);
  await page.route('**/tts.php', routeApi);
  await page.route('https://challenges.cloudflare.com/turnstile/**', async route => {
    await route.fulfill({
      contentType: 'text/javascript',
      body: `window.turnstile={render:function(_selector,options){setTimeout(function(){options.callback('browser-smoke-token')},0);return 'browser-smoke-widget'},remove:function(){},reset:function(){}};`,
    });
  });
  if (failChatChunk) {
    await page.route(/\/ChatWindow-[^/]+\.chunk\.js(?:\?.*)?$/, route => route.abort('failed'));
  }
  if (failPreferencesChunkOnce) {
    await page.route(/\/PreferencesDialog-[^/]+\.chunk\.js(?:\?.*)?$/, route => {
      state.optionalChunkRequests += 1;
      if (state.optionalChunkFailures === 0) {
        state.optionalChunkFailures += 1;
        return route.abort('failed');
      }
      return route.continue();
    });
  }
  return { context, page, state };
};

const waitForComposer = page => page.getByRole('textbox', { name: 'Type your message' }).waitFor();

const assertAccessible = async (page, label) => {
  // Visibility alone permits an in-progress MUI fade or drawer slide. Audit
  // after finite modal animations finish; loading spinners may keep running.
  for (const dialog of await page.getByRole('dialog').all()) {
    await dialog.evaluate(async element => {
      const root = element.closest('.MuiModal-root') ?? element;
      await Promise.all(root.getAnimations({ subtree: true })
        .filter(animation => animation.effect?.getTiming().iterations !== Infinity)
        .map(animation => animation.finished.catch(() => {})));
    });
  }
  await page.addScriptTag({ path: axePath });
  const violations = await page.evaluate(async () => (await globalThis.axe.run(globalThis.document, {
    resultTypes: ['violations'],
    runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'] },
  })).violations.filter(item => item.impact === 'serious' || item.impact === 'critical')
    .map(item => ({ id: item.id, impact: item.impact, nodes: item.nodes.map(node => ({ target: node.target, summary: node.failureSummary })) })));
  assert.deepEqual(violations, [], `${label}: serious accessibility violations: ${JSON.stringify(violations)}`);
};

try {
  const manifest = JSON.parse(await readFile(path.join(distRoot, 'manifest.json'), 'utf8'));
  assert.equal(manifest.id, '/pages/ai/');
  assert.equal(manifest.start_url, '/pages/ai/');
  assert.equal(manifest.scope, '/pages/ai/');

  {
    const { context, page } = await createPage('desktop-screenshot', 'desktop-screenshot');
    await page.route('https://data.windowsforum.com/images/ai/w365-tasks/browser-exact.png', route => route.fulfill({
      contentType: 'image/png',
      body: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=', 'base64'),
    }));
    await page.goto(`${origin}/pages/ai/`);
    await waitForComposer(page);
    await page.getByRole('textbox', { name: 'Type your message' }).fill('Capture the desktop');
    await page.getByRole('textbox', { name: 'Type your message' }).press('Enter');
    const screenshot = page.locator('img[src*="/w365-tasks/"]');
    await screenshot.waitFor();
    await page.waitForFunction(() => {
      const image = document.querySelector('img[src*="/w365-tasks/"]');
      return image?.complete && image.naturalWidth > 0;
    });
    await page.reload();
    await waitForComposer(page);
    await page.locator('img[src*="/w365-tasks/"]').waitFor();
    await context.close();
  }

  {
    const { context, page } = await createPage('pwa-canonical', 'completion');
    await page.goto(`${origin}/pages/ai/`);
    await waitForComposer(page);
    let pwaState;
    for (let attempt = 0; attempt < 30; attempt += 1) {
      pwaState = await page.evaluate(async () => ({
        secure: globalThis.isSecureContext,
        supported: 'serviceWorker' in globalThis.navigator,
        manifest: globalThis.document.querySelector('link[rel="manifest"]')?.getAttribute('href'),
        scopes: (await globalThis.navigator.serviceWorker.getRegistrations())
          .map(registration => registration.scope),
      }));
      if (pwaState.scopes.includes(`${origin}/pages/ai/`)) break;
      await page.waitForTimeout(100);
    }
    assert.equal(pwaState.manifest, '/chatpage/manifest.json');
    assert(
      pwaState.scopes.includes(`${origin}/pages/ai/`),
      `canonical service worker scope was not registered: ${JSON.stringify(pwaState)}`,
    );
    await context.close();
  }

  {
    const { context, page, state } = await createPage('completion', 'completion');
    await page.goto(`${origin}/chatpage/`, { waitUntil: 'networkidle' });
    await waitForComposer(page);
    await page.waitForTimeout(500);
    assert.equal(state.identityCalls, 1, 'cold load must issue exactly one getUserData request');

    const entries = await page.evaluate(() => performance.getEntriesByType('resource').map(entry => entry.name));
    const mainScripts = entries.filter(url => new URL(url).pathname.endsWith('/static/js/main.js'));
    const mainStyles = entries.filter(url => new URL(url).pathname.endsWith('/static/css/main.css'));
    assert.equal(mainScripts.length, 1, `expected one stable main.js fetch, saw ${mainScripts.join(', ')}`);
    assert.equal(mainStyles.length, 1, `expected one stable main.css fetch, saw ${mainStyles.join(', ')}`);

    await page.getByRole('textbox', { name: 'Type your message' }).fill('Browser completion test');
    await page.getByRole('button', { name: 'Send message' }).click();
    await page.getByText('Browser smoke reply', { exact: true }).waitFor();
    assert.equal(state.chatPayloads.length, 1);
    assert.equal(state.chatPayloads[0].expected_identity_id, identityId);

    await page.addScriptTag({ path: axePath });
    const axeResult = await page.evaluate(async () => {
      const result = await globalThis.axe.run(globalThis.document, {
        resultTypes: ['violations'],
        runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'] },
      });
      return result.violations
        .filter(item => item.impact === 'serious' || item.impact === 'critical')
        .map(item => ({ id: item.id, impact: item.impact, nodes: item.nodes.length }));
    });
    assert.deepEqual(axeResult, [], `serious accessibility violations: ${JSON.stringify(axeResult)}`);
    await context.close();
  }

  {
    const mobileViewport = { width: 390, height: 844 };
    const { context, page, state } = await createPage('cold-mobile', 'completion', {
      viewport: mobileViewport,
    });
    const debugCls = process.env.WF_SMOKE_DEBUG_CLS === '1';
    await page.addInitScript(captureSources => {
      globalThis.__wfSmokeVitals = { cls: 0, lcp: 0, shifts: [] };
      try {
        new PerformanceObserver(list => {
          const entries = list.getEntries();
          const last = entries[entries.length - 1];
          if (last) globalThis.__wfSmokeVitals.lcp = last.startTime;
        }).observe({ type: 'largest-contentful-paint', buffered: true });
        new PerformanceObserver(list => {
          for (const entry of list.getEntries()) {
            if (entry.hadRecentInput) continue;
            globalThis.__wfSmokeVitals.cls += entry.value || 0;
            // WF_SMOKE_DEBUG_CLS=1 makes a budget failure diagnosable: which
            // nodes moved, when, and from where to where.
            if (captureSources) {
              globalThis.__wfSmokeVitals.shifts.push({
                value: entry.value,
                time: Math.round(entry.startTime),
                sources: (entry.sources ?? []).map(source => {
                  const node = source.node;
                  const label = node && node.getAttribute ? (node.getAttribute('aria-label') || node.id || '') : '';
                  return {
                    node: node
                      ? `${node.tagName}.${String(node.className ?? '').slice(0, 40)}[${label}]`
                      : 'null',
                    prev: source.previousRect ? [Math.round(source.previousRect.x), Math.round(source.previousRect.y)] : null,
                    cur: source.currentRect ? [Math.round(source.currentRect.x), Math.round(source.currentRect.y)] : null,
                  };
                }),
              });
            }
          }
        }).observe({ type: 'layout-shift', buffered: true });
      } catch {
        // Startup timing below still provides coverage in older Chromium.
      }
    }, debugCls);
    const cdp = await context.newCDPSession(page);
    await cdp.send('Network.enable');
    await cdp.send('Network.emulateNetworkConditions', {
      offline: false,
      latency: 100,
      downloadThroughput: 200_000,
      uploadThroughput: 75_000,
      connectionType: 'cellular3g',
    });
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 });
    const startedAt = Date.now();
    await page.goto(`${origin}/chatpage/`);
    await waitForComposer(page);
    const composerReadyMs = Date.now() - startedAt;
    if (debugCls) {
      // Is the read-aloud button present at composer-ready, or does it mount
      // during the shift window?
      globalThis.__wfInputProbeAtReady = await page.evaluate(() => {
        const area = document.querySelector('.wf-input-area');
        const mute = document.querySelector('button[aria-label="Mute read-aloud"], button[aria-label="Enable read-aloud"]');
        return {
          areaHeight: area?.getBoundingClientRect().height ?? null,
          mutePresent: Boolean(mute),
          buttons: [...(area?.querySelectorAll('button') ?? [])].map(b => b.getAttribute('aria-label')),
        };
      });
      globalThis.__wfRegionProbe = await page.evaluate(() => {
        const dump = [];
        const walk = (el, depth) => {
          if (!el || depth > 3) return;
          const r = el.getBoundingClientRect();
          dump.push(`${'  '.repeat(depth)}${el.tagName}.${String(el.className).slice(0, 40)} h=${Math.round(r.height)} y=${Math.round(r.y)}`);
          for (const child of [...el.children].slice(0, 8)) walk(child, depth + 1);
        };
        walk(document.querySelector('#wf-chat-window'), 0);
        return dump;
      });
    }
    await page.waitForTimeout(500);
    if (debugCls) {
      globalThis.__wfRegionProbeAfter = null;
      globalThis.__wfRegionProbeAfter = await page.evaluate(() => {
        const dump = [];
        const walk = (el, depth) => {
          if (!el || depth > 3) return;
          const r = el.getBoundingClientRect();
          dump.push(`${'  '.repeat(depth)}${el.tagName}.${String(el.className).slice(0, 40)} h=${Math.round(r.height)} y=${Math.round(r.y)}`);
          for (const child of [...el.children].slice(0, 8)) walk(child, depth + 1);
        };
        walk(document.querySelector('#wf-chat-window'), 0);
        return dump;
      });
      globalThis.__wfInputProbeAfter = await page.evaluate(() => {
        const area = document.querySelector('.wf-input-area');
        const mute = document.querySelector('button[aria-label="Mute read-aloud"], button[aria-label="Enable read-aloud"]');
        return {
          areaHeight: area?.getBoundingClientRect().height ?? null,
          mutePresent: Boolean(mute),
          buttons: [...(area?.querySelectorAll('button') ?? [])].map(b => b.getAttribute('aria-label')),
          placeholderLines: Math.round((document.querySelector('.wf-input-area textarea')?.getBoundingClientRect().height ?? 0) / 21),
          alerts: [...document.querySelectorAll('#wf-chat-window [role="alert"]')].map(a => a.textContent?.slice(0, 90)),
        };
      });
    }
    const vitals = await page.evaluate(() => {
      const firstContentfulPaint = performance.getEntriesByName('first-contentful-paint')[0];
      return {
        cls: globalThis.__wfSmokeVitals?.cls ?? 0,
        fcp: firstContentfulPaint?.startTime ?? 0,
        lcp: globalThis.__wfSmokeVitals?.lcp ?? 0,
        shifts: globalThis.__wfSmokeVitals?.shifts ?? [],
      };
    });
    if (debugCls && vitals.cls > 0.05) {
      console.log(`[smoke] input-area at composer-ready: ${JSON.stringify(globalThis.__wfInputProbeAtReady)}`);
      console.log('[smoke] region diff (ready -> after):');
      const before = globalThis.__wfRegionProbe ?? [];
      const after = globalThis.__wfRegionProbeAfter ?? [];
      const max = Math.max(before.length, after.length);
      for (let i = 0; i < max; i += 1) {
        if (before[i] !== after[i]) console.log(`  - ${before[i] ?? '(none)'}
  + ${after[i] ?? '(none)'}`);
      }
      console.log('[smoke] CLS budget exceeded; shift sources:');
      for (const shift of vitals.shifts) {
        console.log(`  v=${shift.value.toFixed(4)} at ${shift.time}ms`);
        for (const source of shift.sources.slice(0, 5)) {
          console.log(`    ${source.node} ${JSON.stringify(source.prev)} -> ${JSON.stringify(source.cur)}`);
        }
      }
      const shotPrefix = process.env.WF_SMOKE_DEBUG_CLS_SHOT || '/tmp/cls-debug';
      await page.screenshot({ path: `${shotPrefix}-after.png` });
      console.log(`[smoke] saved post-shift screenshot to ${shotPrefix}-after.png`);
    }
    assert.equal(state.identityCalls, 1, 'throttled cold load must still issue one identity request');
    assert(composerReadyMs < 10_000, `cold mobile composer took ${composerReadyMs} ms (budget 10000)`);
    assert(vitals.fcp > 0 && vitals.fcp < 6_000, `cold mobile FCP was ${vitals.fcp} ms (budget 6000)`);
    assert(vitals.lcp > 0 && vitals.lcp < 8_000, `cold mobile LCP was ${vitals.lcp} ms (budget 8000)`);
    assert(vitals.cls <= 0.05, `cold mobile CLS was ${vitals.cls} (budget 0.05)`);

    const openHistory = page.getByRole('button', { name: 'Open chat history' });
    await openHistory.click();
    const closeHistory = page.getByRole('button', { name: 'Close chat history' });
    await closeHistory.waitFor();
    const drawer = page.locator('.MuiDrawer-paper').filter({ has: closeHistory });
    await page.waitForFunction(() => {
      const close = globalThis.document.querySelector('[aria-label="Close chat history"]');
      const paper = close?.closest('.MuiDrawer-paper');
      if (!paper) return false;
      const bounds = paper.getBoundingClientRect();
      return bounds.left >= -1 && bounds.right <= globalThis.innerWidth + 1;
    });
    const drawerBox = await drawer.boundingBox();
    assert(drawerBox, 'mobile history drawer must have a visible paper');
    assert(
      drawerBox.width >= mobileViewport.width * 0.85,
      `mobile history drawer is too narrow: ${drawerBox.width}px at ${mobileViewport.width}px`,
    );
    assert(
      drawerBox.width <= 361,
      `mobile history drawer exceeded its 360px cap: ${drawerBox.width}px`,
    );
    assert(
      drawerBox.x >= -1 && drawerBox.x + drawerBox.width <= mobileViewport.width + 1,
      `mobile history drawer escaped the viewport: ${JSON.stringify(drawerBox)}`,
    );

    const assertNoHorizontalOverflow = async label => {
      const widths = await page.evaluate(() => ({
        viewport: globalThis.document.documentElement.clientWidth,
        document: globalThis.document.documentElement.scrollWidth,
        body: globalThis.document.body.scrollWidth,
        chat: globalThis.document.getElementById('wf-chat-window')?.scrollWidth ?? 0,
      }));
      assert(
        widths.document <= widths.viewport + 1
          && widths.body <= widths.viewport + 1
          && widths.chat <= widths.viewport + 1,
        `${label} overflowed horizontally: ${JSON.stringify(widths)}`,
      );
    };
    await assertNoHorizontalOverflow('open mobile history');

    await closeHistory.click();
    await closeHistory.waitFor({ state: 'hidden' });
    await page.waitForFunction(() => (
      globalThis.document.activeElement?.getAttribute('aria-label') === 'Open chat history'
    ));
    await assertNoHorizontalOverflow('closed mobile history');

    process.stdout.write(
      `cold mobile smoke: composer=${composerReadyMs}ms fcp=${Math.round(vitals.fcp)}ms `
      + `lcp=${Math.round(vitals.lcp)}ms cls=${vitals.cls.toFixed(4)} `
      + `drawer=${Math.round(drawerBox.width)}px viewport=${mobileViewport.width}px\n`,
    );
    await context.close();
  }

  {
    const { context, page, state } = await createPage('captcha', 'captcha');
    await page.goto(`${origin}/chatpage/`);
    await waitForComposer(page);
    await page.getByRole('textbox', { name: 'Type your message' }).fill('Browser Turnstile test');
    await page.getByRole('button', { name: 'Send message' }).click();
    await page.getByText('Browser smoke reply', { exact: true }).waitFor();
    assert.equal(state.chatPayloads.length, 2, 'captcha flow must retry the parked turn exactly once');
    assert.equal(state.chatPayloads[1].captcha_token, 'browser-smoke-token');
    assert.equal(state.chatPayloads[1].expected_identity_id, identityId);
    await context.close();
  }

  for (const [name, viewport, createCase] of [
    ['guided-desktop', { width: 1440, height: 1000 }, true],
    ['guided-mobile', { width: 390, height: 844 }, false],
  ]) {
    const { context, page, state } = await createPage(name, 'guided-support', { viewport, blockServiceWorkers: true });
    const browserErrors = [];
    page.on('pageerror', error => browserErrors.push(error.message));
    await page.goto(`${origin}/chatpage/`);
    await waitForComposer(page);
    await page.getByRole('button', { name: 'Troubleshoot Windows', exact: true }).click();
    await page.getByRole('combobox', { name: 'Support case' }).waitFor();

    if (createCase) {
      await page.getByRole('button', { name: 'New guided case' }).click();
      await page.getByRole('textbox', { name: 'What is going wrong?' }).fill('Synthetic update fails with limited disk space');
      await page.getByRole('textbox', { name: 'Windows version' }).fill('Windows 11 24H2');
      await page.getByRole('textbox', { name: 'OS build (optional)' }).fill('26100.1000');
      await page.getByRole('button', { name: 'Create and use case' }).click();
    } else {
      await page.getByRole('combobox', { name: 'Support case' }).click();
      await page.getByRole('option', { name: 'Existing synthetic update case' }).click();
    }
    const caseId = createCase ? 'case_browser_created' : 'case_browser_existing';
    await page.getByRole('button', { name: /^Troubleshooting:/ }).waitFor();
    await page.getByRole('textbox', { name: 'Confirmed facts (one per line)' }).fill('Synthetic system volume has 500 MB available.\nRestarting did not help.');
    await page.getByRole('textbox', { name: 'Recent changes', exact: true }).fill('Attempted a synthetic cumulative update.');
    const savedFacts = page.waitForResponse(response => response.url().endsWith('/chat.php')
      && response.request().postDataJSON()?.action === 'updateSupportCaseProgress');
    await page.getByRole('button', { name: 'Save reviewed facts' }).click();
    await savedFacts;
    const revisionAfterFacts = createCase ? 2 : 4;
    await page.getByText(new RegExp(`Revision ${revisionAfterFacts}$`)).waitFor();
    await assertAccessible(page, `${name} case intake`);
    await page.getByRole('button', { name: /^Troubleshooting:/ }).click();

    // Exercise the local-only diagnostic review without approving any upload.
    await page.locator('input[type="file"]').setInputFiles({
      name: 'synthetic-report.log', mimeType: 'text/plain',
      buffer: Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('Windows synthetic report\r\npassword=synthetic-secret', 'utf16le')]),
    });
    const diagnosticDialog = page.getByRole('dialog', { name: 'Review diagnostic files' });
    await diagnosticDialog.waitFor();
    assert.equal(await diagnosticDialog.getByRole('textbox', { name: 'Reviewed text for synthetic-report.log' }).inputValue(), 'Windows synthetic report\npassword=synthetic-secret');
    await diagnosticDialog.getByRole('button', { name: 'Apply 1 suggested redactions to synthetic-report.log' }).click();
    assert.match(await diagnosticDialog.getByRole('textbox', { name: 'Reviewed text for synthetic-report.log' }).inputValue(), /password=\[REDACTED\]/);
    await diagnosticDialog.getByText('Preview numbered uploaded lines for synthetic-report.log').click();
    assert.match(await diagnosticDialog.getByLabel('Numbered uploaded lines for synthetic-report.log').textContent(), /2 {2}password=\[REDACTED\]/);
    await assertAccessible(page, `${name} diagnostic review`);
    await diagnosticDialog.getByRole('button', { name: 'Cancel review' }).click();
    await diagnosticDialog.waitFor({ state: 'hidden' });
    assert.equal(state.apiPayloads.filter(payload => payload.action === 'uploadChatAttachment').length, 0, 'cancelled diagnostic review must not upload original bytes');

    const question = 'What should I check next on this synthetic Windows PC?';
    await page.getByRole('textbox', { name: 'Type your message' }).fill(question);
    await page.getByRole('button', { name: 'Send message' }).click();
    await page.getByText('Guided support original answer.', { exact: true }).waitFor();
    assert.equal(state.chatPayloads.length, 1);
    assert.equal(state.chatPayloads[0].mode, 'troubleshoot');
    assert.equal(state.chatPayloads[0].support_contract_version, 1);
    assert.equal(state.chatPayloads[0].support_case_id, caseId);
    assert.equal(state.chatPayloads[0].support_case_revision, revisionAfterFacts);
    assert.equal(state.chatPayloads[0].expected_identity_id, identityId);
    assert.equal(state.chatPayloads[0].attachment_ids, undefined);

    await page.getByRole('button', { name: 'View evidence and context' }).click();
    const evidenceDialog = page.getByRole('dialog', { name: 'Evidence and context' });
    await evidenceDialog.waitFor();
    await evidenceDialog.getByText('Guided Windows troubleshooting', { exact: true }).waitFor();
    await evidenceDialog.getByText(`Support case revision ${revisionAfterFacts}`, { exact: true }).waitFor();
    await evidenceDialog.getByRole('link', { name: 'Synthetic Microsoft source record' }).waitFor();
    await evidenceDialog.getByText('Synthetic retrieval excerpt: inspect available storage before retrying.', { exact: true }).waitFor();
    await assertAccessible(page, `${name} evidence drawer`);
    const evidenceBounds = await evidenceDialog.boundingBox();
    assert(evidenceBounds && evidenceBounds.x >= -1 && evidenceBounds.x + evidenceBounds.width <= viewport.width + 1, `${name}: evidence drawer escaped viewport: ${JSON.stringify(evidenceBounds)}`);
    await evidenceDialog.getByRole('button', { name: 'Close', exact: true }).click();
    await evidenceDialog.waitFor({ state: 'hidden' });
    await page.getByRole('button', { name: 'Inspect available storage', exact: true }).click();
    await page.getByRole('combobox', { name: 'Result of this check' }).click();
    await page.getByRole('option', { name: 'No change', exact: true }).click();
    await page.getByRole('textbox', { name: 'What happened?' }).fill('Synthetic test: still 500 MB available; no files deleted.');
    await page.getByRole('button', { name: 'Save result to case' }).click();
    await page.getByText('Result saved to your support case.', { exact: true }).waitFor();
    const recorded = state.supportCases.get(caseId);
    assert.equal(recorded.revision, revisionAfterFacts + 1);
    assert.equal(recorded.progress.attempts.length, 1);
    assert.equal(recorded.progress.attempts[0].id, 'check_free_space');
    assert.equal(recorded.progress.attempts[0].outcome, 'no_change');
    await assertAccessible(page, `${name} recorded support card`);

    await page.getByRole('button', { name: 'Regenerate response', exact: true }).last().click();
    await page.getByText('Guided support alternate answer.', { exact: true }).waitFor();
    assert.equal(state.chatPayloads.length, 2, 'regeneration must send one alternate turn');
    assert.equal(state.apiPayloads.filter(payload => payload.action === 'forkConversation').length, 1);
    assert.equal(state.chatPayloads[1].client_conversation_id, 'conv_browser_fork');
    assert.equal(state.chatPayloads[1].message, question);
    assert.equal(state.chatPayloads[1].reset_conversation, true);
    assert.equal(state.chatPayloads[1].support_case_id, caseId);
    assert.equal(state.chatPayloads[1].support_case_revision, revisionAfterFacts + 1);
    assert(!state.chatPayloads[1].history?.some(message => message.role === 'user' && message.content === question), 'regeneration history must not duplicate the new user turn');
    await page.waitForFunction(() => {
      const store = JSON.parse(globalThis.localStorage.getItem('chat_store:v5:42') || '{}');
      return store.conversations?.conv_browser_fork?.messages.some(message => message.rawContent === 'Guided support alternate answer.');
    });
    const localStore = await page.evaluate(() => JSON.parse(globalThis.localStorage.getItem('chat_store:v5:42')));
    const fork = localStore.conversations.conv_browser_fork;
    const source = localStore.conversations[fork.lineage.parent_conversation_id];
    assert.deepEqual(source.messages, state.sourceTranscriptAtFork, 'regeneration must preserve the original transcript');
    assert.equal(fork.messages.filter(message => message.role === 'user').length, 1, 'regenerated branch must contain exactly one user turn');
    assert.equal(source.messages.filter(message => message.role === 'user').length, 1);
    assert(source.messages.some(message => message.rawContent === 'Guided support original answer.'));
    assert(!fork.messages.some(message => message.rawContent === 'Guided support original answer.'));
    await page.getByRole('button', { name: 'Original approach', exact: true }).click();
    await page.getByText('Guided support original answer.', { exact: true }).waitFor();
    await page.reload();
    await waitForComposer(page);
    await page.getByText('Guided support original answer.', { exact: true }).waitFor();
    await assertAccessible(page, `${name} reloaded preserved original`);
    assert.deepEqual(browserErrors, [], `${name}: browser runtime errors`);
    assert(state.apiPayloads.some(payload => payload.action === 'listSupportCases'));
    assert(state.apiPayloads.some(payload => payload.action === 'getSupportCase'));
    process.stdout.write(`${name} mocked browser flow: case intake/context, local UTF-16 review/cancel, evidence, outcome revision, preserved regeneration/reload, axe passed\n`);
    await context.close();
  }

  {
    const { context, page, state } = await createPage('abort', 'abort');
    await page.goto(`${origin}/chatpage/`);
    await waitForComposer(page);
    await page.getByRole('textbox', { name: 'Type your message' }).fill('Browser abort test');
    await page.getByRole('button', { name: 'Send message' }).click();
    await page.getByText('Browser smoke', { exact: true }).waitFor();
    await page.getByRole('button', { name: 'Stop generation' }).click();
    await page.getByText(/Generation stopped/).waitFor();
    await page.waitForFunction(() => !globalThis.document.querySelector('[aria-label="Stop generation"]'));
    await page.waitForTimeout(100);
    assert.equal(state.streamAborted, true, 'Stop generation must abort the active SSE request');
    await context.close();
  }

  {
    const { context, page, state } = await createPage('lazy-recovery', 'completion', {
      failPreferencesChunkOnce: true,
      blockServiceWorkers: true,
    });
    await page.addInitScript(() => {
      const key = 'wf_browser_smoke_document_loads';
      const count = Number(globalThis.sessionStorage.getItem(key) || '0');
      globalThis.sessionStorage.setItem(key, String(count + 1));
    });
    await page.goto(`${origin}/chatpage/`);
    await waitForComposer(page);
    assert.equal(
      await page.evaluate(() => globalThis.sessionStorage.getItem('wf_browser_smoke_document_loads')),
      '1',
      'optional chunk scenario must start from one document load',
    );

    await page.getByRole('button', { name: 'Chat actions' }).click();
    await page.getByRole('menuitem', { name: 'Chat settings' }).click();
    await page.waitForFunction(() => (
      globalThis.sessionStorage.getItem('wf_browser_smoke_document_loads') === '2'
    ));
    await waitForComposer(page);
    assert.equal(state.optionalChunkFailures, 1, 'optional chunk must fail exactly once');

    await page.getByRole('button', { name: 'Chat actions' }).click();
    await page.getByRole('menuitem', { name: 'Chat settings' }).click();
    await page.getByRole('heading', { name: 'Chat settings' }).waitFor();
    await page.waitForTimeout(250);
    assert.equal(state.optionalChunkRequests, 2, 'recovered dialog must fetch the optional chunk once more');
    assert.equal(
      await page.evaluate(() => globalThis.sessionStorage.getItem('wf_browser_smoke_document_loads')),
      '2',
      'optional chunk recovery must reload the document exactly once',
    );
    await context.close();
  }

  {
    const { context, page, state } = await createPage('chunk-failure', 'completion', {
      failChatChunk: true,
      blockServiceWorkers: true,
    });
    await page.goto(`${origin}/chatpage/`);
    await page.getByText('Oops! Something went wrong').waitFor();
    await page.waitForTimeout(250);
    assert(state.telemetry.some(event => event.event === 'app_error'), 'chunk failure must emit app_error telemetry');
    await context.close();
  }

  process.stdout.write('browser smoke with mocked API/SSE: desktop screenshot/reload, PWA, completion, cold mobile, guided desktop/mobile, abort, Turnstile, lazy recovery, chunk failure, manifest, and axe checks passed\n');
} finally {
  await browser.close();
  await new Promise(resolve => server.close(resolve));
  if (temporaryTlsDirectory) {
    await rm(temporaryTlsDirectory, { force: true, recursive: true });
  }
}
