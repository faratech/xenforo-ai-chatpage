#!/usr/local/bin/php
<?php

declare(strict_types=1);

/**
 * Idempotent storage foundation for member chat history and product features.
 *
 * Inspection is the default. Pass --apply during a coordinated backend rollout;
 * this script is intentionally never invoked by a web request or deploy build.
 */

if (PHP_SAPI !== 'cli') {
    fwrite(STDERR, "CLI only\n");
    exit(1);
}

$apply = in_array('--apply', $argv, true);
$xfRoot = '/web/public_html';
$attachmentRoot = '/web/private/chat-attachments';
require $xfRoot . '/src/XF.php';
\XF::start($xfRoot);
$app = \XF::setupApp(\XF\Cli\App::class);
$db = $app->db();
$schema = (string)$db->fetchOne('SELECT DATABASE()');

$tables = [
    'openai_chatpage_saved_conversations' => "
        CREATE TABLE IF NOT EXISTS openai_chatpage_saved_conversations (
            owner_user_id INT UNSIGNED NOT NULL,
            client_conversation_id VARCHAR(128) NOT NULL,
            revision BIGINT UNSIGNED NOT NULL DEFAULT 1,
            metadata_revision BIGINT UNSIGNED NOT NULL DEFAULT 0,
            title VARCHAR(255) NOT NULL,
            messages_json MEDIUMTEXT NOT NULL,
            message_count INT UNSIGNED NOT NULL DEFAULT 0,
            pinned_at_ms BIGINT UNSIGNED NULL,
            archived_at_ms BIGINT UNSIGNED NULL,
            created_at_ms BIGINT UNSIGNED NOT NULL,
            updated_at_ms BIGINT UNSIGNED NOT NULL,
            PRIMARY KEY (owner_user_id, client_conversation_id),
            KEY idx_owner_updated (owner_user_id, updated_at_ms, client_conversation_id)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_uca1400_ai_ci
    ",
    'openai_chatpage_conversation_tombstones' => "
        CREATE TABLE IF NOT EXISTS openai_chatpage_conversation_tombstones (
            owner_user_id INT UNSIGNED NOT NULL,
            conversation_id_hash CHAR(64) NOT NULL,
            deleted_at_ms BIGINT UNSIGNED NOT NULL,
            expires_at INT UNSIGNED NOT NULL,
            PRIMARY KEY (owner_user_id, conversation_id_hash),
            KEY idx_tombstone_expiry (expires_at)
        ) ENGINE=InnoDB DEFAULT CHARSET=ascii COLLATE=ascii_bin
    ",
    'openai_chatpage_feedback' => "
        CREATE TABLE IF NOT EXISTS openai_chatpage_feedback (
            feedback_id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
            actor_hash CHAR(64) NOT NULL,
            owner_user_id INT UNSIGNED NULL,
            client_conversation_id VARCHAR(128) NULL,
            response_id VARCHAR(128) NOT NULL,
            turn_id VARCHAR(64) NOT NULL,
            rating VARCHAR(8) NOT NULL,
            reason VARCHAR(500) NULL,
            created_at_ms BIGINT UNSIGNED NOT NULL,
            updated_at_ms BIGINT UNSIGNED NOT NULL,
            PRIMARY KEY (feedback_id),
            UNIQUE KEY uq_actor_response_turn (actor_hash, response_id, turn_id),
            KEY idx_response (response_id),
            KEY idx_owner_updated (owner_user_id, updated_at_ms),
            KEY idx_feedback_retention (updated_at_ms, feedback_id)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_uca1400_ai_ci
    ",
    'openai_chatpage_attachments' => "
        CREATE TABLE IF NOT EXISTS openai_chatpage_attachments (
            attachment_id VARCHAR(40) NOT NULL,
            owner_user_id INT UNSIGNED NOT NULL,
            client_conversation_id VARCHAR(128) NULL,
            storage_key VARCHAR(128) NOT NULL,
            original_name VARCHAR(255) NOT NULL,
            mime_type VARCHAR(100) NOT NULL,
            attachment_kind VARCHAR(16) NOT NULL,
            size_bytes BIGINT UNSIGNED NOT NULL,
            sha256 CHAR(64) NOT NULL,
            status VARCHAR(16) NOT NULL DEFAULT 'ready',
            expires_at INT UNSIGNED NOT NULL,
            created_at_ms BIGINT UNSIGNED NOT NULL,
            updated_at_ms BIGINT UNSIGNED NOT NULL,
            PRIMARY KEY (attachment_id),
            UNIQUE KEY uq_storage_key (storage_key),
            KEY idx_owner_created (owner_user_id, created_at_ms),
            KEY idx_expiry_status (expires_at, status),
            KEY idx_owner_active_bytes (owner_user_id, status, expires_at, size_bytes)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_uca1400_ai_ci
    ",
    'openai_chatpage_shares' => "
        CREATE TABLE IF NOT EXISTS openai_chatpage_shares (
            share_id VARCHAR(40) NOT NULL,
            owner_user_id INT UNSIGNED NOT NULL,
            client_conversation_id VARCHAR(128) NOT NULL,
            source_revision BIGINT UNSIGNED NOT NULL,
            token_hash CHAR(64) NOT NULL,
            snapshot_json MEDIUMTEXT NOT NULL,
            created_at_ms BIGINT UNSIGNED NOT NULL,
            expires_at INT UNSIGNED NOT NULL,
            revoked_at INT UNSIGNED NULL,
            PRIMARY KEY (share_id),
            UNIQUE KEY uq_token_hash (token_hash),
            KEY idx_owner_created (owner_user_id, created_at_ms),
            KEY idx_expiry_revoked (expires_at, revoked_at)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_uca1400_ai_ci
    ",
    'openai_chatpage_support_cases' => "
        CREATE TABLE IF NOT EXISTS openai_chatpage_support_cases (
            case_id VARCHAR(40) NOT NULL,
            owner_user_id INT UNSIGNED NOT NULL,
            revision BIGINT UNSIGNED NOT NULL DEFAULT 1,
            title VARCHAR(255) NOT NULL,
            description TEXT NOT NULL,
            status VARCHAR(16) NOT NULL DEFAULT 'open',
            pc_profile_json TEXT NOT NULL,
            created_at_ms BIGINT UNSIGNED NOT NULL,
            updated_at_ms BIGINT UNSIGNED NOT NULL,
            PRIMARY KEY (case_id),
            KEY idx_owner_updated (owner_user_id, updated_at_ms, case_id)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_uca1400_ai_ci
    ",
    'openai_chatpage_support_case_conversations' => "
        CREATE TABLE IF NOT EXISTS openai_chatpage_support_case_conversations (
            case_id VARCHAR(40) NOT NULL,
            owner_user_id INT UNSIGNED NOT NULL,
            client_conversation_id VARCHAR(128) NOT NULL,
            created_at_ms BIGINT UNSIGNED NOT NULL,
            PRIMARY KEY (case_id, client_conversation_id),
            KEY idx_owner_conversation (owner_user_id, client_conversation_id)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_uca1400_ai_ci
    ",
    'openai_chatpage_support_case_attachments' => "
        CREATE TABLE IF NOT EXISTS openai_chatpage_support_case_attachments (
            case_id VARCHAR(40) NOT NULL,
            owner_user_id INT UNSIGNED NOT NULL,
            attachment_id VARCHAR(40) NOT NULL,
            created_at_ms BIGINT UNSIGNED NOT NULL,
            PRIMARY KEY (case_id, attachment_id),
            KEY idx_owner_attachment (owner_user_id, attachment_id)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_uca1400_ai_ci
    ",
    'openai_chatpage_events' => "
        CREATE TABLE IF NOT EXISTS openai_chatpage_events (
            event_key CHAR(64) NOT NULL,
            actor_hash CHAR(64) NOT NULL,
            is_member TINYINT UNSIGNED NOT NULL DEFAULT 0,
            event_name VARCHAR(64) NOT NULL,
            surface VARCHAR(32) NOT NULL,
            release_id VARCHAR(240) NULL,
            error_code VARCHAR(64) NULL,
            outcome VARCHAR(32) NULL,
            duration_ms INT UNSIGNED NULL,
            metric_value DECIMAL(12,4) NULL,
            created_at_ms BIGINT UNSIGNED NOT NULL,
            PRIMARY KEY (event_key),
            KEY idx_event_created (event_name, created_at_ms),
            KEY idx_created (created_at_ms)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_uca1400_ai_ci
    ",
];

$existing = $db->fetchAllColumn("
    SELECT TABLE_NAME
    FROM information_schema.TABLES
    WHERE TABLE_SCHEMA = ? AND TABLE_NAME IN (" . $db->quote(array_keys($tables)) . ")
", [$schema]);
$existing = array_fill_keys(array_map('strval', $existing), true);
$missing = array_values(array_filter(array_keys($tables), static fn(string $table): bool => !isset($existing[$table])));
$requiredColumns = [
    'openai_chatpage_saved_conversations' => [
        'metadata_revision' => 'ALTER TABLE openai_chatpage_saved_conversations ADD COLUMN metadata_revision BIGINT UNSIGNED NOT NULL DEFAULT 0 AFTER revision',
        'pinned_at_ms' => 'ALTER TABLE openai_chatpage_saved_conversations ADD COLUMN pinned_at_ms BIGINT UNSIGNED NULL AFTER message_count',
        'archived_at_ms' => 'ALTER TABLE openai_chatpage_saved_conversations ADD COLUMN archived_at_ms BIGINT UNSIGNED NULL AFTER pinned_at_ms',
    ],
];
$missingColumns = [];
foreach ($requiredColumns as $table => $columns) {
    if (!isset($existing[$table])) continue;
    $presentColumns = $db->fetchAllColumn("
        SELECT COLUMN_NAME
        FROM information_schema.COLUMNS
        WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?
    ", [$schema, $table]);
    $presentColumns = array_fill_keys(array_map('strval', $presentColumns), true);
    foreach ($columns as $column => $sql) {
        if (!isset($presentColumns[$column])) $missingColumns["{$table}.{$column}"] = $sql;
    }
}
$requiredIndexes = [
    'openai_chatpage_conversation_tombstones' => [
        'idx_tombstone_expiry' => 'ALTER TABLE openai_chatpage_conversation_tombstones ADD KEY idx_tombstone_expiry (expires_at)',
    ],
    'openai_chatpage_feedback' => [
        'idx_feedback_retention' => 'ALTER TABLE openai_chatpage_feedback ADD KEY idx_feedback_retention (updated_at_ms, feedback_id)',
    ],
    'openai_chatpage_attachments' => [
        'idx_owner_active_bytes' => 'ALTER TABLE openai_chatpage_attachments ADD KEY idx_owner_active_bytes (owner_user_id, status, expires_at, size_bytes)',
    ],
];
$missingIndexes = [];
foreach ($requiredIndexes as $table => $indexes) {
    if (!isset($existing[$table])) continue;
    $presentIndexes = $db->fetchAllColumn("
        SELECT DISTINCT INDEX_NAME
        FROM information_schema.STATISTICS
        WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?
    ", [$schema, $table]);
    $presentIndexes = array_fill_keys(array_map('strval', $presentIndexes), true);
    foreach ($indexes as $index => $sql) {
        if (!isset($presentIndexes[$index])) $missingIndexes["{$table}.{$index}"] = $sql;
    }
}
$nobodyUser = function_exists('posix_getpwnam') ? posix_getpwnam('nobody') : false;
$nobodyGroup = function_exists('posix_getgrnam') ? posix_getgrnam('nobody') : false;
$rootReady = is_dir($attachmentRoot)
    && !is_link($attachmentRoot)
    && realpath($attachmentRoot) === $attachmentRoot
    && is_writable($attachmentRoot)
    && ((fileperms($attachmentRoot) & 0777) === 0700)
    && is_array($nobodyUser)
    && is_array($nobodyGroup)
    && fileowner($attachmentRoot) === (int)$nobodyUser['uid']
    && filegroup($attachmentRoot) === (int)$nobodyGroup['gid'];

if (!$missing && !$missingColumns && !$missingIndexes && $rootReady) {
    echo "chat product schema and attachment root already current\n";
    exit(0);
}

$needed = $missing;
array_push($needed, ...array_keys($missingColumns));
array_push($needed, ...array_keys($missingIndexes));
if (!$rootReady) $needed[] = 'prepare private attachment root';
echo ($apply ? 'apply: ' : 'dry-run: ') . implode(', ', $needed) . "\n";
if (!$apply) {
    echo "rerun with --apply during the coordinated backend rollout\n";
    exit(2);
}

$privateParent = dirname($attachmentRoot);
$privateParentMode = is_dir($privateParent) ? (fileperms($privateParent) & 0777) : 0;
if (realpath($privateParent) !== '/web/private' || is_link($privateParent)
    || fileowner($privateParent) !== 0 || ($privateParentMode & 0022) !== 0) {
    throw new RuntimeException('Private attachment parent must be a real, root-owned, non-writable /web/private directory');
}
if (!is_array($nobodyUser) || !is_array($nobodyGroup)) {
    throw new RuntimeException('Could not resolve the nobody worker account and group');
}
if (is_link($attachmentRoot)) {
    throw new RuntimeException('Private attachment root must not be a symlink');
}

foreach ($missing as $table) {
    $db->query($tables[$table]);
}
foreach ($missingColumns as $sql) {
    $db->query($sql);
}
foreach ($missingIndexes as $sql) {
    $db->query($sql);
}

if (!is_dir($attachmentRoot) && !mkdir($attachmentRoot, 0700, false) && !is_dir($attachmentRoot)) {
    throw new RuntimeException("Could not create {$attachmentRoot}");
}
if (!chown($attachmentRoot, 'nobody') || !chgrp($attachmentRoot, 'nobody') || !chmod($attachmentRoot, 0700)) {
    throw new RuntimeException("Could not secure {$attachmentRoot} for the lsphp worker");
}

echo "chat product foundation migration complete\n";
