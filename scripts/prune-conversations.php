#!/usr/bin/env php
<?php

declare(strict_types=1);

/**
 * Remove inactive chatpage conversations from the provider and local mapping.
 *
 * Dry-run is the default:
 *   php scripts/prune-conversations.php
 *   php scripts/prune-conversations.php --days=30 --limit=100 --apply
 */

use GuzzleHttp\Client;

const LEASE_TTL = 180;
const DELETE_STALE_AFTER = 300;

if (PHP_SAPI !== 'cli') {
    fwrite(STDERR, "CLI only\n");
    exit(1);
}

$options = getopt('', ['days:', 'limit:', 'apply']);
$days = max(7, min(3650, (int)($options['days'] ?? 30)));
$limit = max(1, min(500, (int)($options['limit'] ?? 100)));
$apply = isset($options['apply']);
$cutoff = time() - ($days * 86400);

$xfRoot = '/web/public_html';
require $xfRoot . '/wf_chat_predicates.php';
require $xfRoot . '/src/config.php';
require $xfRoot . '/src/XF.php';
\XF::start($xfRoot);
$app = \XF::setupApp(\XF\Cli\App::class);
$db = $app->db();

$now = time();
$staleDeleteCutoff = $now - DELETE_STALE_AFTER;
$rows = $db->fetchAll("
    SELECT owner_user_id, client_conversation_id, conversation_id, last_used_at,
           status, delete_started_at
    FROM openai_chatpage_conversations
    WHERE (last_used_at < ? OR status = 'delete_failed')
      AND conversation_id LIKE 'conv\\_%'
      AND (status <> 'deleting' OR delete_started_at IS NULL OR delete_started_at <= ?)
    ORDER BY last_used_at ASC
    LIMIT {$limit}
", [$cutoff, $staleDeleteCutoff]);

$outboxRows = $db->fetchAll("
    SELECT conversation_id, owner_user_id, client_conversation_id, attempts
    FROM openai_chatpage_delete_outbox
    WHERE next_attempt_at <= ?
    ORDER BY next_attempt_at ASC, created_at ASC
    LIMIT {$limit}
", [$now]);

printf(
    "%s: %d mapped conversation(s), %d compensation(s) ready (age %d days, limit %d each)\n",
    $apply ? 'apply' : 'dry-run',
    count($rows),
    count($outboxRows),
    $days,
    $limit
);

if (!$apply || (!$rows && !$outboxRows)) {
    exit(0);
}

$client = new Client(['timeout' => 20, 'http_errors' => false]);
$secretKey = (string)($config['secretKey'] ?? '');
try {
    $redis = \WindowsForum\SharedRedis::raw();
} catch (Throwable $error) {
    fwrite(STDERR, 'Redis coordination unavailable: ' . $error->getMessage() . "\n");
    exit(1);
}
if ($secretKey === '') {
    fwrite(STDERR, "XenForo secretKey unavailable\n");
    exit(1);
}

function acquireLease(Redis $redis, string $identityId, string $clientConversationId, string $owner): ?array
{
    $key = wfChatConversationLeaseKey($identityId, $clientConversationId);
    return $redis->set($key, $owner, ['nx', 'ex' => LEASE_TTL])
        ? ['key' => $key, 'owner' => $owner] : null;
}

function renewLease(Redis $redis, array $lease): bool
{
    return (int)$redis->eval(
        "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('expire', KEYS[1], ARGV[2]) end return 0",
        [$lease['key'], $lease['owner'], LEASE_TTL],
        1
    ) === 1;
}

function releaseLease(Redis $redis, array $lease): void
{
    try {
        $redis->eval(
            "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) end return 0",
            [$lease['key'], $lease['owner']],
            1
        );
    } catch (Throwable $error) {
        fwrite(STDERR, 'lease release failed: ' . $error->getMessage() . "\n");
    }
}

function deleteProviderConversation(Client $client, string $conversationId): void
{
    $response = $client->delete(
        'http://127.0.0.1:8001/openai/conversations/' . rawurlencode($conversationId)
    );
    $status = $response->getStatusCode();
    if (!(($status >= 200 && $status < 300) || $status === 404 || $status === 410)) {
        throw new RuntimeException("provider returned HTTP {$status}");
    }
}

function purgeReplayLedger(Redis $redis, string $identityId, string $clientConversationId): void
{
    $index = wfChatTurnReplayIndexKey($identityId, $clientConversationId);
    $keys = $redis->sMembers($index);
    if (is_array($keys)) {
        foreach ($keys as $key) {
            if (is_string($key) && str_starts_with($key, 'wf:ai:chatturn:done:')) $redis->del($key);
        }
    }
    $cursor = null;
    $pattern = 'wf:ai:chatturn:done:'
        . wfChatConversationScope($identityId, $clientConversationId) . ':*';
    do {
        $batch = $redis->scan($cursor, $pattern, 100);
        if (is_array($batch)) {
            foreach ($batch as $key) {
                if (is_string($key)) $redis->del($key);
            }
        }
    } while ($cursor !== 0 && $cursor !== '0');
    $redis->del($index);
}

$deleted = 0;
$failed = 0;
$skipped = 0;

foreach ($rows as $row) {
    $identityId = wfChatIdentityId((string)$row['owner_user_id'], $secretKey);
    $lease = acquireLease(
        $redis,
        (string)$identityId,
        (string)$row['client_conversation_id'],
        'prune-' . bin2hex(random_bytes(8))
    );
    if (!$lease) {
        $skipped++;
        continue;
    }

    try {
        $deleteStartedAt = time();
        $claimed = $db->query("
            UPDATE openai_chatpage_conversations
            SET status = 'deleting', delete_started_at = ?, last_error = NULL
            WHERE owner_user_id = ?
              AND client_conversation_id = ?
              AND conversation_id = ?
              AND (last_used_at < ? OR status = 'delete_failed')
              AND (status <> 'deleting' OR delete_started_at IS NULL OR delete_started_at <= ?)
        ", [
            $deleteStartedAt,
            $row['owner_user_id'],
            $row['client_conversation_id'],
            $row['conversation_id'],
            $cutoff,
            time() - DELETE_STALE_AFTER,
        ])->rowsAffected();
        if ($claimed !== 1) {
            $skipped++;
            continue;
        }

        if (!renewLease($redis, $lease)) throw new RuntimeException('conversation lease was lost');
        deleteProviderConversation($client, (string)$row['conversation_id']);
        purgeReplayLedger($redis, (string)$identityId, (string)$row['client_conversation_id']);

        $removed = $db->query("
            DELETE FROM openai_chatpage_conversations
            WHERE owner_user_id = ?
              AND client_conversation_id = ?
              AND conversation_id = ?
              AND status = 'deleting'
              AND delete_started_at = ?
        ", [
            $row['owner_user_id'],
            $row['client_conversation_id'],
            $row['conversation_id'],
            $deleteStartedAt,
        ])->rowsAffected();
        if ($removed !== 1) throw new RuntimeException('final local delete did not affect exactly one row');
        $deleted++;
    } catch (Throwable $error) {
        $db->query("
            UPDATE openai_chatpage_conversations
            SET status = 'delete_failed', last_error = ?
            WHERE owner_user_id = ?
              AND client_conversation_id = ?
              AND conversation_id = ?
              AND status = 'deleting'
              AND delete_started_at = ?
        ", [
            substr($error->getMessage(), 0, 500),
            $row['owner_user_id'],
            $row['client_conversation_id'],
            $row['conversation_id'],
            $deleteStartedAt,
        ]);
        $failed++;
    } finally {
        releaseLease($redis, $lease);
    }
}

foreach ($outboxRows as $row) {
    $identityId = wfChatIdentityId((string)$row['owner_user_id'], $secretKey);
    $clientConversationId = (string)($row['client_conversation_id'] ?? 'compensation');
    if ($clientConversationId === '') $clientConversationId = 'compensation';
    $lease = acquireLease(
        $redis,
        (string)$identityId,
        $clientConversationId,
        'outbox-' . bin2hex(random_bytes(8))
    );
    if (!$lease) {
        $skipped++;
        continue;
    }

    try {
        deleteProviderConversation($client, (string)$row['conversation_id']);
        $removed = $db->query("
            DELETE FROM openai_chatpage_delete_outbox
            WHERE conversation_id = ?
        ", [$row['conversation_id']])->rowsAffected();
        if ($removed !== 1) throw new RuntimeException('final outbox delete did not affect exactly one row');
        $deleted++;
    } catch (Throwable $error) {
        $attempts = (int)$row['attempts'] + 1;
        $delay = min(3600, 60 * (2 ** min(6, $attempts - 1)));
        $db->query("
            UPDATE openai_chatpage_delete_outbox
            SET attempts = ?, last_error = ?, next_attempt_at = ?
            WHERE conversation_id = ?
        ", [
            $attempts,
            substr($error->getMessage(), 0, 500),
            time() + $delay,
            $row['conversation_id'],
        ]);
        $failed++;
    } finally {
        releaseLease($redis, $lease);
    }
}

printf("deleted=%d failed=%d skipped=%d\n", $deleted, $failed, $skipped);
exit($failed > 0 ? 1 : 0);
