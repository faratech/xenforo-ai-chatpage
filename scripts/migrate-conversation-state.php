#!/usr/bin/env php
<?php

declare(strict_types=1);

/**
 * Idempotent schema preparation for race-safe chat conversation deletion.
 * Inspection is the default; pass --apply before activating the matching PHP.
 */

if (PHP_SAPI !== 'cli') {
    fwrite(STDERR, "CLI only\n");
    exit(1);
}

$apply = in_array('--apply', $argv, true);
$xfRoot = '/web/public_html';
require $xfRoot . '/src/XF.php';
\XF::start($xfRoot);
$app = \XF::setupApp(\XF\Cli\App::class);
$db = $app->db();
$schema = (string)$db->fetchOne('SELECT DATABASE()');

$hasDeleteStartedAt = (int)$db->fetchOne("
    SELECT COUNT(*)
    FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = ? AND TABLE_NAME = 'openai_chatpage_conversations'
      AND COLUMN_NAME = 'delete_started_at'
", [$schema]) === 1;
$hasAttempts = (int)$db->fetchOne("
    SELECT COUNT(*)
    FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = ? AND TABLE_NAME = 'openai_chatpage_conversations'
      AND COLUMN_NAME = 'attempts'
", [$schema]) === 1;
$hasNextAttemptAt = (int)$db->fetchOne("
    SELECT COUNT(*)
    FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = ? AND TABLE_NAME = 'openai_chatpage_conversations'
      AND COLUMN_NAME = 'next_attempt_at'
", [$schema]) === 1;
$hasDeleteIndex = (int)$db->fetchOne("
    SELECT COUNT(*)
    FROM information_schema.STATISTICS
    WHERE TABLE_SCHEMA = ? AND TABLE_NAME = 'openai_chatpage_conversations'
      AND INDEX_NAME = 'idx_status_delete_started'
", [$schema]) > 0;
$hasBackoffIndex = (int)$db->fetchOne("
    SELECT COUNT(*)
    FROM information_schema.STATISTICS
    WHERE TABLE_SCHEMA = ? AND TABLE_NAME = 'openai_chatpage_conversations'
      AND INDEX_NAME = 'idx_delete_failed_next_attempt'
", [$schema]) > 0;
$hasOutbox = (int)$db->fetchOne("
    SELECT COUNT(*)
    FROM information_schema.TABLES
    WHERE TABLE_SCHEMA = ? AND TABLE_NAME = 'openai_chatpage_delete_outbox'
", [$schema]) === 1;

$needed = [];
if (!$hasDeleteStartedAt) $needed[] = 'add delete_started_at';
if (!$hasAttempts) $needed[] = 'add delete attempts';
if (!$hasNextAttemptAt) $needed[] = 'add delete next_attempt_at';
if (!$hasDeleteIndex) $needed[] = 'add deletion retry index';
if (!$hasBackoffIndex) $needed[] = 'add delete_failed backoff index';
if (!$hasOutbox) $needed[] = 'create compensation outbox';

if (!$needed) {
    echo "conversation schema already current\n";
    exit(0);
}

echo ($apply ? 'apply: ' : 'dry-run: ') . implode(', ', $needed) . "\n";
if (!$apply) {
    echo "rerun with --apply before activating the hardened backend\n";
    exit(2);
}

if (!$hasDeleteStartedAt) {
    $db->query("
        ALTER TABLE openai_chatpage_conversations
        ADD COLUMN delete_started_at INT UNSIGNED NULL AFTER status
    ");
}

if (!$hasAttempts) {
    $db->query("
        ALTER TABLE openai_chatpage_conversations
        ADD COLUMN attempts INT UNSIGNED NOT NULL DEFAULT 0 AFTER delete_started_at
    ");
}

if (!$hasNextAttemptAt) {
    $db->query("
        ALTER TABLE openai_chatpage_conversations
        ADD COLUMN next_attempt_at INT UNSIGNED NOT NULL DEFAULT 0 AFTER attempts
    ");
}

if (!$hasDeleteIndex) {
    $db->query("
        ALTER TABLE openai_chatpage_conversations
        ADD KEY idx_status_delete_started (status, delete_started_at)
    ");
}

if (!$hasBackoffIndex) {
    $db->query("
        ALTER TABLE openai_chatpage_conversations
        ADD KEY idx_delete_failed_next_attempt (status, next_attempt_at)
    ");
}

$db->query("
    CREATE TABLE IF NOT EXISTS openai_chatpage_delete_outbox (
        conversation_id VARCHAR(128) NOT NULL,
        owner_user_id VARCHAR(255) NOT NULL,
        client_conversation_id VARCHAR(128) DEFAULT NULL,
        attempts INT UNSIGNED NOT NULL DEFAULT 0,
        last_error TEXT DEFAULT NULL,
        next_attempt_at INT UNSIGNED NOT NULL DEFAULT 0,
        created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        PRIMARY KEY (conversation_id),
        KEY idx_next_attempt (next_attempt_at)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_uca1400_ai_ci
");

echo "conversation schema migration complete\n";
