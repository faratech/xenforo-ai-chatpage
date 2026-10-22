<?php

declare(strict_types=1);

/** Bounded, dependency-free support DTO validation. Runtime ownership stays in chat.php. */
require_once __DIR__ . '/chat-product-contract.php';

function wfChatSupportCapabilities(array $flags): array
{
    $features = [];
    foreach (['guided_support', 'diagnostics', 'branches', 'support_cards'] as $feature) {
        $features[$feature] = ($flags[$feature] ?? false) === true;
    }
    $features['support_cards'] = $features['support_cards'] && $features['guided_support'];
    return ['success' => true, 'version' => 1,
        'modes' => $features['guided_support'] ? ['chat', 'troubleshoot'] : ['chat'],
        'features' => $features, 'limits' => [
            'max_attachments' => 4, 'max_image_bytes' => 8388608, 'max_text_file_bytes' => 1048576,
            'max_total_text_bytes' => 131072, 'max_total_image_bytes' => 10485760,
        ]];
}

function wfChatSupportNormalizeProgress($value, ?string &$error = null): ?array
{
    $error = 'invalid_support_progress';
    if (!is_array($value) || !is_array($value['confirmed_facts'] ?? null)
        || count($value['confirmed_facts']) > 30 || !is_array($value['attempts'] ?? null)
        || count($value['attempts']) > 50) return null;
    $facts = [];
    foreach ($value['confirmed_facts'] as $fact) {
        $text = wfChatProductCleanText($fact, 500, false);
        if ($text === null || $text === '') return null;
        $facts[] = $text;
    }
    $recent = wfChatProductCleanText($value['recent_changes'] ?? '', 4000, true);
    if ($recent === null) return null;
    $attempts = [];
    $seen = [];
    foreach ($value['attempts'] as $attempt) {
        if (!is_array($attempt)) return null;
        $id = wfChatProductNormalizeOpaqueId($attempt['id'] ?? null, 160);
        $check = wfChatProductCleanText($attempt['check'] ?? null, 1000, true);
        $outcome = $attempt['outcome'] ?? null;
        if ($id === null || isset($seen[$id]) || $check === null || $check === ''
            || !in_array($outcome, ['helped', 'no_change', 'worse', 'not_attempted'], true)) return null;
        $seen[$id] = true;
        $item = ['id' => $id, 'check' => $check, 'outcome' => $outcome];
        foreach (['expected_result' => 1000, 'observed_result' => 2000] as $key => $limit) {
            if (!isset($attempt[$key])) continue;
            $text = wfChatProductCleanText($attempt[$key], $limit, true);
            if ($text === null) return null;
            if ($text !== '') $item[$key] = $text;
        }
        $attempts[] = $item;
    }
    $result = ['confirmed_facts' => $facts, 'recent_changes' => $recent, 'attempts' => $attempts];
    if (strlen((string)json_encode($result)) > 48000) return null;
    $error = null;
    return $result;
}

function wfChatSupportNormalizeLineage($value): ?array
{
    if (!is_array($value)) return null;
    $parent = wfChatProductConversationId($value['parent_conversation_id'] ?? null);
    $fork = wfChatProductNormalizeOpaqueId($value['fork_message_id'] ?? null, 160);
    $family = wfChatProductConversationId($value['family_id'] ?? null);
    return $parent !== null && $fork !== null && $family !== null
        ? ['parent_conversation_id' => $parent, 'fork_message_id' => $fork, 'family_id' => $family] : null;
}

function wfChatSupportNormalizeContext($value): ?array
{
    if (!is_array($value) || !in_array($value['mode'] ?? null, ['chat', 'troubleshoot'], true)) return null;
    $ids = wfChatProductNormalizeIdList($value['included_attachment_ids'] ?? [], 'wfChatProductAttachmentId', 4);
    if ($ids === null || !is_int($value['history_items'] ?? null) || $value['history_items'] < 0
        || $value['history_items'] > 20) return null;
    $out = ['mode' => $value['mode'], 'included_attachment_ids' => $ids,
        'history_items' => $value['history_items'], 'history_limit' => 20, 'history_item_bytes' => 4000];
    if (isset($value['case_id'])) {
        $id = wfChatProductCaseId($value['case_id']);
        $revision = wfChatProductExpectedRevision($value['case_revision'] ?? null, false);
        if ($id === null || $revision === null || $value['mode'] !== 'troubleshoot') return null;
        $out['case_id'] = $id;
        $out['case_revision'] = $revision;
    }
    foreach (['history_truncated', 'recovery_used'] as $key) {
        if (isset($value[$key])) {
            if (!is_bool($value[$key])) return null;
            $out[$key] = $value[$key];
        }
    }
    return $out;
}

function wfChatSupportNormalizeCard($value): ?array
{
    if (!is_array($value)) return null;
    $id = wfChatProductNormalizeOpaqueId($value['id'] ?? null, 160);
    if ($id === null || !is_array($value['evidence_ids'] ?? null) || count($value['evidence_ids']) > 20) return null;
    $out = ['id' => $id];
    foreach (['check' => 1000, 'explanation' => 2000, 'expected_result' => 1000] as $key => $limit) {
        $text = wfChatProductCleanText($value[$key] ?? null, $limit, true);
        if ($text === null || $text === '') return null;
        $out[$key] = $text;
    }
    $out['evidence_ids'] = [];
    foreach ($value['evidence_ids'] as $evidenceId) {
        $evidenceId = wfChatProductNormalizeOpaqueId($evidenceId, 160);
        if ($evidenceId === null) return null;
        $out['evidence_ids'][] = $evidenceId;
    }
    if (isset($value['command'])) {
        $command = wfChatProductCleanText($value['command'], 4000, true);
        if ($command === null) return null;
        if ($command !== '') $out['command'] = $command;
    }
    return $out;
}

function wfChatSupportNormalizeEvidence($value): ?array
{
    if (!is_array($value) || count($value) > 20) return null;
    $out = [];
    foreach ($value as $item) {
        if (!is_array($item)) return null;
        $id = wfChatProductNormalizeOpaqueId($item['id'] ?? null, 160);
        $title = wfChatProductCleanText($item['title'] ?? null, 500, false);
        $kind = $item['kind'] ?? null;
        if ($id === null || $title === null || $title === ''
            || !in_array($kind, ['microsoft', 'forum', 'web', 'diagnostic'], true)) return null;
        $evidence = ['id' => $id, 'kind' => $kind, 'title' => $title];
        if (isset($item['url'])) {
            $url = trim((string)$item['url']);
            if (strlen($url) > 2048 || filter_var($url, FILTER_VALIDATE_URL) === false
                || !in_array(strtolower((string)parse_url($url, PHP_URL_SCHEME)), ['http', 'https'], true)) return null;
            $evidence['url'] = $url;
        }
        foreach (['excerpt' => 2000, 'published_at' => 80, 'retrieved_at' => 80, 'os_relevance' => 255] as $key => $limit) {
            if (!isset($item[$key])) continue;
            $text = wfChatProductCleanText($item[$key], $limit, $key === 'excerpt');
            if ($text === null) return null;
            if ($text !== '') $evidence[$key] = $text;
        }
        if (isset($item['attachment_id'])) {
            $aid = wfChatProductAttachmentId($item['attachment_id']);
            if ($aid === null || $kind !== 'diagnostic') return null;
            $evidence['attachment_id'] = $aid;
        }
        if (isset($item['line_start']) || isset($item['line_end'])) {
            $start = wfChatProductExpectedRevision($item['line_start'] ?? null, false);
            $end = wfChatProductExpectedRevision($item['line_end'] ?? null, false);
            if ($start === null || $end === null || $end < $start || $end > 1000000 || $kind !== 'diagnostic') return null;
            $evidence['line_start'] = $start;
            $evidence['line_end'] = $end;
        }
        $out[] = $evidence;
    }
    return $out;
}

function wfChatSupportNormalizeEvent(array $event): ?array
{
    $type = $event['type'] ?? '';
    if ($type === 'chat.context') {
        $value = wfChatSupportNormalizeContext($event['context'] ?? null);
        return $value === null ? null : ['type' => $type, 'context' => $value];
    }
    if ($type === 'chat.support_card') {
        $value = wfChatSupportNormalizeCard($event['card'] ?? null);
        return $value === null ? null : ['type' => $type, 'card' => $value];
    }
    if ($type === 'chat.evidence') {
        $value = wfChatSupportNormalizeEvidence($event['evidence'] ?? null);
        return $value === null ? null : ['type' => $type, 'evidence' => $value];
    }
    if ($type === 'chat.activity') {
        $value = $event['activity'] ?? null;
        if (!is_array($value)) return null;
        $id = wfChatProductNormalizeOpaqueId($value['id'] ?? null, 160);
        $label = wfChatProductCleanText($value['label'] ?? null, 160, false);
        if ($id === null || $label === null || $label === ''
            || !in_array($value['state'] ?? null, ['active', 'done', 'failed', 'cancelled'], true)) return null;
        $item = ['id' => $id, 'label' => $label, 'state' => $value['state']];
        if (isset($value['detail'])) {
            $detail = wfChatProductCleanText($value['detail'], 2000, true);
            if ($detail === null) return null;
            if ($detail !== '') $item['detail'] = $detail;
        }
        return ['type' => $type, 'activity' => $item];
    }
    return null;
}

/** Text only: BOM-marked UTF-16 is decoded; XML is never parsed. */
function wfChatSupportDecodeDiagnostic(string $bytes): ?string
{
    if (strlen($bytes) > 1048576) return null;
    if (str_starts_with($bytes, "\xFF\xFE")) {
        if (!mb_check_encoding(substr($bytes, 2), 'UTF-16LE')) return null;
        $bytes = mb_convert_encoding(substr($bytes, 2), 'UTF-8', 'UTF-16LE');
    } elseif (str_starts_with($bytes, "\xFE\xFF")) {
        if (!mb_check_encoding(substr($bytes, 2), 'UTF-16BE')) return null;
        $bytes = mb_convert_encoding(substr($bytes, 2), 'UTF-8', 'UTF-16BE');
    }
    elseif (str_starts_with($bytes, "\xEF\xBB\xBF")) $bytes = substr($bytes, 3);
    if ($bytes === '' || !mb_check_encoding($bytes, 'UTF-8') || strlen($bytes) > 1048576
        || preg_match('/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/', $bytes)) return null;
    return str_replace(["\r\n", "\r"], "\n", $bytes);
}

function wfChatSupportForkPrefix(array $messages, string $messageId, string $kind): ?array
{
    if (!in_array($kind, ['branch', 'edit', 'regenerate'], true)) return null;
    foreach ($messages as $index => $message) {
        if (($message['id'] ?? null) !== $messageId) continue;
        if (($kind === 'edit' && ($message['role'] ?? '') !== 'user')
            || ($kind === 'regenerate' && ($message['role'] ?? '') !== 'ai')) return null;
        return array_slice($messages, 0, $index + ($kind === 'branch' ? 1 : 0));
    }
    return null;
}

function wfChatSupportFingerprint(string $message, bool $reset, string $attachmentFingerprint,
    array $history, string $mode, ?array $case): string
{
    return hash('sha256', (string)json_encode([$message, $reset, $attachmentFingerprint, $history, $mode,
        $case === null ? null : [$case['id'], $case['revision'], $case]], JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES));
}

/** Recognize reviewed derivatives from the supported text-export filenames. */
function wfChatSupportDiagnosticFilename(string $name): bool
{
    $name = basename(str_replace('\\', '/', $name));
    return preg_match('/\.(?:log|xml|nfo)$/i', $name) === 1
        || preg_match('/\.(?:txt|csv|json|log|xml|nfo)\.reviewed\.txt$/i', $name) === 1;
}

function wfChatSupportContractVersion(array $input): ?int
{
    if (!array_key_exists('support_contract_version', $input)) return 0;
    return $input['support_contract_version'] === 1 ? 1 : null;
}

/** Old browser retries retain the byte-for-byte legacy ledger key during rollout. */
function wfChatSupportRequestFingerprint(string $message, bool $reset, string $attachmentFingerprint,
    array $history, string $mode, ?array $case, int $contractVersion): string
{
    if ($contractVersion === 1 || $mode === 'troubleshoot' || $case !== null) {
        return wfChatSupportFingerprint($message, $reset, $attachmentFingerprint, $history, $mode, $case);
    }
    return hash('sha256', $message . "\0" . ($reset ? 'reset' : 'continue') . "\0" . $attachmentFingerprint);
}

function wfChatSupportTextAttachment(string $name, string $mime, string $bytes, string $attachmentId,
    bool $diagnosticsEnabled): array
{
    if (!$diagnosticsEnabled) {
        return ['text_block' => "\n\n--- User attachment: {$name} ({$mime}) ---\n{$bytes}\n--- End user attachment ---", 'evidence' => []];
    }
    $lines = explode("\n", $bytes);
    $lineCount = count($lines);
    $evidenceId = 'diagnostic_' . $attachmentId;
    $numbered = [];
    foreach ($lines as $index => $line) $numbered[] = ($index + 1) . ': ' . $line;
    $text = implode("\n", $numbered);
    return ['text_block' => "\n\n--- User attachment: {$name} ({$mime}); evidence {$evidenceId}; reviewed derivative lines 1-{$lineCount} ---\n{$text}\n--- End user attachment ---",
        'evidence' => [['id' => $evidenceId, 'kind' => 'diagnostic', 'title' => $name,
            'attachment_id' => $attachmentId, 'line_start' => 1, 'line_end' => $lineCount]]];
}
