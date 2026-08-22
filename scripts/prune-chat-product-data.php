#!/usr/local/bin/php
<?php

declare(strict_types=1);

/**
 * Bounded retention for uploaded chat files, share snapshots, feedback, and event data.
 * Dry-run is the default; the systemd unit invokes the explicit --apply mode.
 */

if (PHP_SAPI !== 'cli') {
    fwrite(STDERR, "CLI only\n");
    exit(1);
}

require __DIR__ . '/chat-product-contract.php';

function wfChatProductPruneFile(string $root, string $storageKey, bool $apply): string
{
    if (wfChatProductAttachmentStorageKey($storageKey) === null) {
        throw new RuntimeException('invalid attachment storage key');
    }
    $realRoot = realpath($root);
    if ($realRoot === false || $realRoot !== $root || is_link($root)) {
        throw new RuntimeException('private attachment root is unavailable or unsafe');
    }
    $path = $root . '/' . $storageKey;
    if (!file_exists($path) && !is_link($path)) return 'missing';
    $realPath = realpath($path);
    if ($realPath === false || !is_file($realPath)
        || is_link($path) || is_link(dirname($path))
        || !str_starts_with($realPath, $realRoot . DIRECTORY_SEPARATOR)) {
        throw new RuntimeException('attachment path escaped private root');
    }
    if (!$apply) return 'eligible';
    if (!unlink($realPath)) throw new RuntimeException('attachment unlink failed');
    return 'deleted';
}

function wfChatProductPrunerSelfTest(): void
{
    $root = sys_get_temp_dir() . '/wf-chat-pruner-' . bin2hex(random_bytes(8));
    $key = 'aa/att_' . str_repeat('a', 32) . '.bin';
    $path = $root . '/' . $key;
    if (!mkdir(dirname($path), 0700, true) || file_put_contents($path, 'bounded-test') === false) {
        throw new RuntimeException('could not prepare retention self-test');
    }
    try {
        if (wfChatProductPruneFile($root, $key, false) !== 'eligible' || !is_file($path)) {
            throw new RuntimeException('dry-run changed an eligible file');
        }
        if (wfChatProductPruneFile($root, $key, true) !== 'deleted' || file_exists($path)) {
            throw new RuntimeException('apply did not remove the exact eligible file');
        }
        if (wfChatProductPruneFile($root, $key, true) !== 'missing') {
            throw new RuntimeException('missing file was not idempotent');
        }
    } finally {
        if (is_file($path) || is_link($path)) unlink($path);
        if (is_dir(dirname($path))) rmdir(dirname($path));
        if (is_dir($root)) rmdir($root);
    }
    echo "chat product retention dry-run/apply self-test passed\n";
}

$options = getopt('', ['file-limit:', 'row-limit:', 'event-days:', 'feedback-days:', 'pending-minutes:', 'apply', 'self-test']);
if (isset($options['self-test'])) {
    wfChatProductPrunerSelfTest();
    exit(0);
}
$fileLimit = max(1, min(2000, (int)($options['file-limit'] ?? 500)));
$rowLimit = max(1, min(20000, (int)($options['row-limit'] ?? 5000)));
$eventDays = max(30, min(365, (int)($options['event-days'] ?? 90)));
$feedbackDays = max(90, min(730, (int)($options['feedback-days'] ?? 365)));
$pendingMinutes = max(15, min(1440, (int)($options['pending-minutes'] ?? 60)));
$apply = isset($options['apply']);
$now = time();
$nowMs = (int)$now * 1000;
$eventCutoffMs = ((int)$now - $eventDays * 86400) * 1000;
$feedbackCutoffMs = ((int)$now - $feedbackDays * 86400) * 1000;
$pendingCutoffMs = ((int)$now - $pendingMinutes * 60) * 1000;
$attachmentRoot = '/web/private/chat-attachments';

$xfRoot = '/web/public_html';
require $xfRoot . '/src/XF.php';
\XF::start($xfRoot);
$app = \XF::setupApp(\XF\Cli\App::class);
$db = $app->db();

$requiredTables = [
    'openai_chatpage_saved_conversations',
    'openai_chatpage_conversation_tombstones',
    'openai_chatpage_attachments',
    'openai_chatpage_shares',
    'openai_chatpage_feedback',
    'openai_chatpage_events',
    'openai_chatpage_support_cases',
    'openai_chatpage_support_case_conversations',
    'openai_chatpage_support_case_attachments',
];
$schema = (string)$db->fetchOne('SELECT DATABASE()');
$presentTables = $db->fetchAllColumn("
    SELECT TABLE_NAME
    FROM information_schema.TABLES
    WHERE TABLE_SCHEMA = ? AND TABLE_NAME IN (" . $db->quote($requiredTables) . ")
", [$schema]);
$presentTables = array_fill_keys(array_map('strval', $presentTables), true);
$missingTables = array_values(array_filter(
    $requiredTables,
    static fn(string $table): bool => !isset($presentTables[$table])
));
if ($missingTables) {
    fwrite(STDERR, 'chat product schema incomplete; cleanup refused (missing tables: '
        . implode(', ', $missingTables) . ")\n");
    exit(2);
}

$requiredIndexes = [
    'openai_chatpage_feedback' => ['idx_feedback_retention'],
    'openai_chatpage_attachments' => ['idx_owner_active_bytes'],
    'openai_chatpage_conversation_tombstones' => ['idx_tombstone_expiry'],
];
$missingIndexes = [];
foreach ($requiredIndexes as $table => $indexes) {
    $presentIndexes = $db->fetchAllColumn("
        SELECT DISTINCT INDEX_NAME
        FROM information_schema.STATISTICS
        WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?
    ", [$schema, $table]);
    $presentIndexes = array_fill_keys(array_map('strval', $presentIndexes), true);
    foreach ($indexes as $index) {
        if (!isset($presentIndexes[$index])) $missingIndexes[] = "{$table}.{$index}";
    }
}
if ($missingIndexes) {
    fwrite(STDERR, 'chat product schema incomplete; cleanup refused (missing indexes: '
        . implode(', ', $missingIndexes) . ")\n");
    exit(2);
}

$attachments = $db->fetchAll("
    SELECT attachment_id, owner_user_id, storage_key
    FROM openai_chatpage_attachments
    WHERE expires_at <= ? OR status IN ('expired', 'deleted', 'deleting')
       OR (status = 'pending' AND updated_at_ms < ?)
    ORDER BY expires_at ASC
    LIMIT {$fileLimit}
", [$now, $pendingCutoffMs]);
$shares = $db->fetchAll("
    SELECT share_id, owner_user_id
    FROM openai_chatpage_shares
    WHERE expires_at <= ? OR revoked_at IS NOT NULL
    ORDER BY expires_at ASC
    LIMIT {$rowLimit}
", [$now]);
$eventKeys = $db->fetchAllColumn("
    SELECT event_key
    FROM openai_chatpage_events
    WHERE created_at_ms < ?
    ORDER BY created_at_ms ASC
    LIMIT {$rowLimit}
", [$eventCutoffMs]);
$feedbackIds = $db->fetchAllColumn("
    SELECT feedback_id
    FROM openai_chatpage_feedback
    WHERE updated_at_ms < ?
    ORDER BY updated_at_ms ASC
    LIMIT {$rowLimit}
", [$feedbackCutoffMs]);
$tombstones = $db->fetchAll("
    SELECT owner_user_id, conversation_id_hash
    FROM openai_chatpage_conversation_tombstones
    WHERE expires_at <= ?
    ORDER BY expires_at ASC
    LIMIT {$rowLimit}
", [$now]);

printf(
    "%s: attachments=%d shares=%d feedback=%d events=%d tombstones=%d (file_limit=%d, row_limit=%d, feedback_days=%d, event_days=%d, pending_minutes=%d)\n",
    $apply ? 'apply' : 'dry-run',
    count($attachments),
    count($shares),
    count($feedbackIds),
    count($eventKeys),
    count($tombstones),
    $fileLimit,
    $rowLimit,
    $feedbackDays,
    $eventDays,
    $pendingMinutes
);
if (!$apply || (!$attachments && !$shares && !$feedbackIds && !$eventKeys && !$tombstones)) exit(0);

$deletedAttachments = 0;
$deletedShares = 0;
$deletedFeedback = 0;
$deletedEvents = 0;
$deletedTombstones = 0;
$failed = 0;
$contestedClaims = 0;

foreach ($attachments as $attachment) {
    $attachmentId = wfChatProductAttachmentId($attachment['attachment_id'] ?? null);
    $storageKey = wfChatProductAttachmentStorageKey($attachment['storage_key'] ?? null);
    $ownerUserId = filter_var($attachment['owner_user_id'] ?? null, FILTER_VALIDATE_INT, [
        'options' => ['min_range' => 1],
    ]);
    if ($attachmentId === null || $storageKey === null || $ownerUserId === false) {
        fwrite(STDERR, "Refusing invalid attachment row\n");
        $failed++;
        continue;
    }

    $transactionOpen = false;
    try {
        // Claim the exact owner/id/storage row before touching its file. A
        // failed unlink leaves a non-readable `deleting` row for a later retry.
        $db->beginTransaction();
        $transactionOpen = true;
        $claimed = $db->query("
            UPDATE openai_chatpage_attachments
            SET status = 'deleting', updated_at_ms = ?
            WHERE attachment_id = ? AND owner_user_id = ? AND storage_key = ?
              AND (expires_at <= ? OR status IN ('expired', 'deleted', 'deleting')
                   OR (status = 'pending' AND updated_at_ms < ?))
        ", [$nowMs, $attachmentId, $ownerUserId, $storageKey, $now, $pendingCutoffMs]);
        $db->commit();
        $transactionOpen = false;
        if ($claimed->rowsAffected() !== 1) {
            // Another prune run claimed this row first. Not a failure, but
            // silently swallowing the contest made the summary understate
            // what happened to this candidate.
            $contestedClaims++;
            fwrite(STDERR, "attachment {$attachmentId}: claim lost to another runner\n");
            continue;
        }

        wfChatProductPruneFile($attachmentRoot, $storageKey, true);
        $db->beginTransaction();
        $transactionOpen = true;
        $db->query(
            'DELETE FROM openai_chatpage_support_case_attachments WHERE owner_user_id = ? AND attachment_id = ?',
            [$ownerUserId, $attachmentId]
        );
        $db->query("
            DELETE FROM openai_chatpage_attachments
            WHERE owner_user_id = ? AND attachment_id = ? AND storage_key = ? AND status = 'deleting'
        ", [$ownerUserId, $attachmentId, $storageKey]);
        $db->commit();
        $transactionOpen = false;
        $deletedAttachments++;
    } catch (Throwable $error) {
        if ($transactionOpen) $db->rollback();
        fwrite(STDERR, "attachment {$attachmentId}: {$error->getMessage()}\n");
        $failed++;
    }
}

if ($shares) {
    try {
        $result = $db->query("
            DELETE FROM openai_chatpage_shares
            WHERE expires_at <= ? OR revoked_at IS NOT NULL
            ORDER BY expires_at ASC
            LIMIT {$rowLimit}
        ", [$now]);
        $deletedShares = $result->rowsAffected();
    } catch (Throwable $error) {
        fwrite(STDERR, "share cleanup failed: {$error->getMessage()}\n");
        $failed++;
    }
}

if ($eventKeys) {
    try {
        $result = $db->query("
            DELETE FROM openai_chatpage_events
            WHERE created_at_ms < ?
            ORDER BY created_at_ms ASC
            LIMIT {$rowLimit}
        ", [$eventCutoffMs]);
        $deletedEvents = $result->rowsAffected();
    } catch (Throwable $error) {
        fwrite(STDERR, "event cleanup failed: {$error->getMessage()}\n");
        $failed++;
    }
}

if ($feedbackIds) {
    try {
        $result = $db->query("
            DELETE FROM openai_chatpage_feedback
            WHERE updated_at_ms < ?
            ORDER BY updated_at_ms ASC
            LIMIT {$rowLimit}
        ", [$feedbackCutoffMs]);
        $deletedFeedback = $result->rowsAffected();
    } catch (Throwable $error) {
        fwrite(STDERR, "feedback cleanup failed: {$error->getMessage()}\n");
        $failed++;
    }
}

if ($tombstones) {
    try {
        $result = $db->query("
            DELETE FROM openai_chatpage_conversation_tombstones
            WHERE expires_at <= ?
            ORDER BY expires_at ASC
            LIMIT {$rowLimit}
        ", [$now]);
        $deletedTombstones = $result->rowsAffected();
    } catch (Throwable $error) {
        fwrite(STDERR, "tombstone cleanup failed: {$error->getMessage()}\n");
        $failed++;
    }
}

printf(
    "deleted_attachments=%d deleted_shares=%d deleted_feedback=%d deleted_events=%d deleted_tombstones=%d contested_claims=%d failed=%d\n",
    $deletedAttachments,
    $deletedShares,
    $deletedFeedback,
    $deletedEvents,
    $deletedTombstones,
    $contestedClaims,
    $failed
);
exit($failed > 0 ? 1 : 0);
