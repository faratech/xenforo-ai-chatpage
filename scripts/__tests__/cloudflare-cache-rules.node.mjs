import assert from 'node:assert/strict';
import test from 'node:test';
import {
  proposedChatExpression,
  proposedMediaExpression,
} from '../update-cloudflare-chatpage-cache.mjs';

test('chatpage assets are removed from the broad chat bypass exactly once', () => {
  const current = '(http.request.uri.path eq "/chat.php") or (http.request.uri.path contains "/chatpage")';
  const proposed = proposedChatExpression(current);
  assert.match(proposed, /starts_with\(http\.request\.uri\.path, "\/chatpage\/static\/"\)/);
  assert.match(proposed, /"\/chatpage\/bot-avatar\.webp"/);
  assert.equal(proposedChatExpression(proposed), proposed);
});

test('chatpage transform fails closed when the live clause drifts', () => {
  assert.throws(
    () => proposedChatExpression('(http.request.uri.path wildcard r"/chatpage/*")'),
    /expected exactly one occurrence/,
  );
});

test('stable chat media are excluded from the later generic image override', () => {
  const current = '(http.request.uri.path.extension eq "webp")';
  const proposed = proposedMediaExpression(current);
  assert.match(proposed, /http\.host eq "windowsforum\.com"/);
  assert.match(proposed, /"\/chatpage\/bot-avatar\.webp"/);
  assert.match(proposed, /"\/chatpage\/pwa-icon-192\.png"/);
  assert.match(proposed, /"\/chatpage\/pwa-icon-512\.png"/);
  assert.equal(proposedMediaExpression(proposed), proposed);
});

test('legacy avatar-only exclusion is upgraded without nesting the rule again', () => {
  const current = '((http.request.uri.path.extension eq "png")) and not ((http.host eq "windowsforum.com") and (http.request.uri.path eq "/chatpage/bot-avatar.webp"))';
  const proposed = proposedMediaExpression(current);
  assert.match(proposed, /^\(\(http\.request\.uri\.path\.extension eq "png"\)\) and not/);
  assert.match(proposed, /"\/chatpage\/pwa-icon-192\.png"/);
  assert.doesNotMatch(proposed, /\)\)\) and not/);
});
