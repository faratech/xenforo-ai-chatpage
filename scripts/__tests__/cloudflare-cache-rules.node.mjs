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

test('stable avatar is excluded from the later generic image override', () => {
  const current = '(http.request.uri.path.extension eq "webp")';
  const proposed = proposedMediaExpression(current);
  assert.match(proposed, /http\.host eq "windowsforum\.com"/);
  assert.match(proposed, /http\.request\.uri\.path eq "\/chatpage\/bot-avatar\.webp"/);
  assert.equal(proposedMediaExpression(proposed), proposed);
});
