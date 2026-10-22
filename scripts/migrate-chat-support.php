<?php

declare(strict_types=1);

/** Dry run by default. Apply explicitly, backend first, before enabling any support flag. */
if (PHP_SAPI !== 'cli') { http_response_code(404); exit; }
$tables = [
    'openai_chatpage_case_progress' => "CREATE TABLE IF NOT EXISTS openai_chatpage_case_progress (
        owner_user_id INT UNSIGNED NOT NULL,
        case_id VARCHAR(40) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
        progress_json MEDIUMTEXT NOT NULL,
        PRIMARY KEY (owner_user_id, case_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci",
    'openai_chatpage_conversation_context' => "CREATE TABLE IF NOT EXISTS openai_chatpage_conversation_context (
        owner_user_id INT UNSIGNED NOT NULL,
        client_conversation_id VARCHAR(128) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
        mode VARCHAR(20) CHARACTER SET ascii COLLATE ascii_bin NOT NULL DEFAULT 'chat',
        support_case_id VARCHAR(40) CHARACTER SET ascii COLLATE ascii_bin NULL,
        lineage_json TEXT NULL,
        created_at_ms BIGINT UNSIGNED NOT NULL,
        PRIMARY KEY (owner_user_id, client_conversation_id),
        KEY case_owner (owner_user_id, support_case_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci",
    'openai_chatpage_response_details' => "CREATE TABLE IF NOT EXISTS openai_chatpage_response_details (
        owner_user_id INT UNSIGNED NOT NULL,
        client_conversation_id VARCHAR(128) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
        turn_id VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
        response_id VARCHAR(128) CHARACTER SET ascii COLLATE ascii_bin NULL,
        details_json MEDIUMTEXT NOT NULL,
        created_at_ms BIGINT UNSIGNED NOT NULL,
        PRIMARY KEY (owner_user_id, client_conversation_id, turn_id),
        KEY created_at (created_at_ms)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci",
];
if (!in_array('--apply', $argv, true)) {
    echo "DRY RUN: no database connection or writes. Use --apply to create companion tables.\n";
    foreach ($tables as $sql) echo $sql . ";\n\n";
    exit;
}
require_once '/web/public_html/src/XF.php';
\XF::start('/web/public_html');
$db = \XF::db();
foreach ($tables as $name => $sql) {
    $db->query($sql);
    echo "Ready: {$name}\n";
}
