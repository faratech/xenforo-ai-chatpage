<?php

declare(strict_types=1);

/**
 * Pure validation and cursor helpers shared by chat.php and its CLI tests.
 *
 * Keep this file dependency-free. It is deliberately unable to access the
 * database, filesystem, XenForo session, or network; those authorization and
 * ownership checks remain in chat.php.
 */

const WF_CHAT_PRODUCT_MAX_MESSAGES = 250;
const WF_CHAT_PRODUCT_MAX_MESSAGES_JSON_BYTES = 220000;
const WF_CHAT_PRODUCT_MAX_MESSAGE_BYTES = 32768;
const WF_CHAT_PRODUCT_MAX_ANNOTATIONS = 20;
const WF_CHAT_PRODUCT_MAX_ACTIVITIES = 20;
const WF_CHAT_PRODUCT_MAX_MESSAGE_ATTACHMENTS = 8;
const WF_CHAT_PRODUCT_MAX_SAVED_CONVERSATIONS = 50;
const WF_CHAT_PRODUCT_MAX_SUPPORT_CASES = 100;
const WF_CHAT_PRODUCT_MAX_ACTIVE_SHARES = 100;
const WF_CHAT_PRODUCT_MAX_RETAINED_SHARES = 500;
const WF_CHAT_PRODUCT_MAX_ACTIVE_ATTACHMENT_BYTES = 67108864;
const WF_CHAT_PRODUCT_TOMBSTONE_SECONDS = 31536000;
const WF_CHAT_PRODUCT_SHARE_DEFAULT_SECONDS = 604800;
const WF_CHAT_PRODUCT_SHARE_MIN_SECONDS = 3600;
const WF_CHAT_PRODUCT_SHARE_MAX_SECONDS = 2592000;

function wfChatProductCleanText($value, int $maxBytes, bool $allowNewlines = true): ?string
{
    if (!is_string($value) || $maxBytes < 1 || !mb_check_encoding($value, 'UTF-8')) {
        return null;
    }

    $pattern = $allowNewlines
        ? '/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/u'
        : '/[\x00-\x1F\x7F]/u';
    $text = preg_replace($pattern, '', $value);
    if (!is_string($text)) return null;
    $text = trim($text);
    if (strlen($text) > $maxBytes) {
        $text = mb_strcut($text, 0, $maxBytes, 'UTF-8');
    }
    return $text;
}

function wfChatProductConversationId($value): ?string
{
    if (!is_string($value)) return null;
    $value = trim($value);
    return preg_match('/^[A-Za-z0-9_-]{1,128}$/', $value) === 1 ? $value : null;
}

function wfChatProductAttachmentId($value): ?string
{
    if (!is_string($value)) return null;
    $value = strtolower(trim($value));
    return preg_match('/^att_[a-f0-9]{32}$/', $value) === 1 ? $value : null;
}

function wfChatProductAttachmentStorageKey($value): ?string
{
    if (!is_string($value)) return null;
    $value = trim($value);
    return preg_match('/^[a-f0-9]{2}\/att_[a-f0-9]{32}\.bin$/', $value) === 1 ? $value : null;
}

function wfChatProductResponseId($value): ?string
{
    if (!is_string($value)) return null;
    $value = trim($value);
    return preg_match('/^resp_[A-Za-z0-9_-]{1,120}$/', $value) === 1 ? $value : null;
}

function wfChatProductTurnId($value): ?string
{
    if (!is_string($value)) return null;
    $value = trim($value);
    return preg_match('/^[A-Za-z0-9_-]{1,64}$/', $value) === 1 ? $value : null;
}

function wfChatProductShareId($value): ?string
{
    if (!is_string($value)) return null;
    $value = strtolower(trim($value));
    return preg_match('/^share_[a-f0-9]{32}$/', $value) === 1 ? $value : null;
}

function wfChatProductShareToken($value): ?string
{
    if (!is_string($value)) return null;
    $value = trim($value);
    return preg_match('/^[A-Za-z0-9_-]{40,96}$/', $value) === 1 ? $value : null;
}

function wfChatProductCaseId($value): ?string
{
    if (!is_string($value)) return null;
    $value = strtolower(trim($value));
    return preg_match('/^case_[a-f0-9]{32}$/', $value) === 1 ? $value : null;
}

function wfChatProductExpectedRevision($value, bool $allowZero = true): ?int
{
    if (is_int($value)) {
        $revision = $value;
    } elseif (is_string($value) && preg_match('/^\d+$/', $value) === 1) {
        $revision = (int)$value;
    } else {
        return null;
    }
    if ($revision < ($allowZero ? 0 : 1) || $revision > PHP_INT_MAX - 1) return null;
    return $revision;
}

function wfChatProductTimestampMs($value, ?int $fallback = null): ?int
{
    if (is_int($value)) $timestamp = $value;
    elseif (is_float($value) && is_finite($value)) $timestamp = (int)$value;
    elseif (is_string($value) && preg_match('/^\d{1,16}$/', $value) === 1) $timestamp = (int)$value;
    else return $fallback;

    // Plausible browser timestamp: after 2000-01-01 and not over a day ahead.
    $max = (int)floor(microtime(true) * 1000) + 86400000;
    return ($timestamp >= 946684800000 && $timestamp <= $max) ? $timestamp : $fallback;
}

function wfChatProductNormalizeOpaqueId($value, int $maxBytes = 255): ?string
{
    if (!is_string($value)) return null;
    $value = trim($value);
    if ($value === '' || strlen($value) > $maxBytes) return null;
    return preg_match('/^[A-Za-z0-9_.:-]+$/', $value) === 1 ? $value : null;
}

function wfChatProductNormalizeAnnotation($value): ?array
{
    if (!is_array($value) || !is_string($value['type'] ?? null)) return null;
    $type = $value['type'];
    if ($type === 'url_citation') {
        $url = is_string($value['url'] ?? null) ? trim($value['url']) : '';
        if ($url === '' || strlen($url) > 2048 || filter_var($url, FILTER_VALIDATE_URL) === false) return null;
        $scheme = strtolower((string)parse_url($url, PHP_URL_SCHEME));
        if (!in_array($scheme, ['http', 'https'], true)) return null;
        $result = ['type' => $type, 'url' => $url];
        if (isset($value['title'])) {
            $title = wfChatProductCleanText($value['title'], 500, false);
            if ($title === null) return null;
            if ($title !== '') $result['title'] = $title;
        }
        return $result;
    }

    if (!in_array($type, ['file_citation', 'container_file_citation', 'file_path'], true)) return null;
    $result = ['type' => $type];
    foreach (['fileId', 'containerId'] as $key) {
        if (isset($value[$key])) {
            $id = wfChatProductNormalizeOpaqueId($value[$key]);
            if ($id === null) return null;
            $result[$key] = $id;
        }
    }
    if (isset($value['filename'])) {
        $filename = wfChatProductCleanText($value['filename'], 255, false);
        if ($filename === null) return null;
        if ($filename !== '') $result['filename'] = $filename;
    }
    return count($result) > 1 ? $result : null;
}

function wfChatProductNormalizeMessages($value, ?string &$error = null): ?array
{
    $error = null;
    if (!is_array($value) || count($value) > WF_CHAT_PRODUCT_MAX_MESSAGES) {
        $error = 'invalid_message_count';
        return null;
    }

    $messages = [];
    foreach ($value as $message) {
        if (!is_array($message)) {
            $error = 'invalid_message';
            return null;
        }
        $id = wfChatProductNormalizeOpaqueId($message['id'] ?? null, 160);
        $role = $message['role'] ?? null;
        $content = wfChatProductCleanText($message['rawContent'] ?? null, WF_CHAT_PRODUCT_MAX_MESSAGE_BYTES, true);
        $timestamp = wfChatProductTimestampMs($message['timestamp'] ?? null);
        if ($id === null || !in_array($role, ['user', 'ai'], true) || $content === null || $timestamp === null) {
            $error = 'invalid_message';
            return null;
        }
        $normalized = [
            'id' => $id,
            'role' => $role,
            'rawContent' => $content,
            'timestamp' => $timestamp,
        ];
        if (isset($message['status'])) {
            $status = $message['status'];
            if (!in_array($status, ['complete', 'sending', 'stopped', 'interrupted', 'failed'], true)) {
                $error = 'invalid_message_status';
                return null;
            }
            $normalized['status'] = $status;
        }
        if (isset($message['responseId'])) {
            $responseId = wfChatProductResponseId($message['responseId']);
            if ($responseId === null) {
                $error = 'invalid_response_id';
                return null;
            }
            $normalized['responseId'] = $responseId;
        }
        if (isset($message['turnId'])) {
            $turnId = wfChatProductTurnId($message['turnId']);
            if ($turnId === null) {
                $error = 'invalid_turn_id';
                return null;
            }
            $normalized['turnId'] = $turnId;
        }
        if (isset($message['annotations'])) {
            if (!is_array($message['annotations']) || count($message['annotations']) > WF_CHAT_PRODUCT_MAX_ANNOTATIONS) {
                $error = 'invalid_annotations';
                return null;
            }
            $annotations = [];
            foreach ($message['annotations'] as $annotation) {
                $item = wfChatProductNormalizeAnnotation($annotation);
                if ($item === null) {
                    $error = 'invalid_annotation';
                    return null;
                }
                $annotations[] = $item;
            }
            if ($annotations) $normalized['annotations'] = $annotations;
        }
        if (isset($message['activities'])) {
            if (!is_array($message['activities']) || count($message['activities']) > WF_CHAT_PRODUCT_MAX_ACTIVITIES) {
                $error = 'invalid_activities';
                return null;
            }
            $activities = [];
            foreach ($message['activities'] as $activity) {
                if (!is_array($activity)) {
                    $error = 'invalid_activity';
                    return null;
                }
                $activityId = wfChatProductNormalizeOpaqueId($activity['id'] ?? null, 160);
                $label = wfChatProductCleanText($activity['label'] ?? null, 160, false);
                $state = $activity['state'] ?? null;
                if ($activityId === null || $label === null || $label === ''
                    || !in_array($state, ['active', 'done'], true)) {
                    $error = 'invalid_activity';
                    return null;
                }
                $item = ['id' => $activityId, 'label' => $label, 'state' => $state];
                if (isset($activity['detail'])) {
                    $detail = wfChatProductCleanText($activity['detail'], 2000, true);
                    if ($detail === null) {
                        $error = 'invalid_activity';
                        return null;
                    }
                    if ($detail !== '') $item['detail'] = $detail;
                }
                $activities[] = $item;
            }
            if ($activities) $normalized['activities'] = $activities;
        }
        if (isset($message['attachments'])) {
            if (!is_array($message['attachments'])
                || count($message['attachments']) > WF_CHAT_PRODUCT_MAX_MESSAGE_ATTACHMENTS) {
                $error = 'invalid_message_attachments';
                return null;
            }
            $attachments = [];
            foreach ($message['attachments'] as $attachment) {
                if (!is_array($attachment)) {
                    $error = 'invalid_message_attachment';
                    return null;
                }
                $attachmentId = wfChatProductAttachmentId($attachment['id'] ?? null);
                $name = wfChatProductCleanText($attachment['name'] ?? null, 255, false);
                $mime = is_string($attachment['mime'] ?? null) ? strtolower(trim($attachment['mime'])) : '';
                $size = $attachment['size'] ?? null;
                if ($attachmentId === null || $name === null || $name === ''
                    || preg_match('/^[a-z0-9.+-]+\/[a-z0-9.+-]+$/', $mime) !== 1
                    || !(is_int($size) || (is_string($size) && ctype_digit($size)))
                    || (int)$size < 0 || (int)$size > 10485760) {
                    $error = 'invalid_message_attachment';
                    return null;
                }
                $attachments[] = [
                    'id' => $attachmentId,
                    'name' => $name,
                    'mime' => $mime,
                    'size' => (int)$size,
                ];
            }
            if ($attachments) $normalized['attachments'] = $attachments;
        }
        $messages[] = $normalized;
    }

    $json = json_encode($messages, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE);
    if (!is_string($json) || strlen($json) > WF_CHAT_PRODUCT_MAX_MESSAGES_JSON_BYTES) {
        $error = 'messages_too_large';
        return null;
    }
    return $messages;
}

/**
 * Reduce a private saved transcript to the presentation-only public share DTO.
 * This is intentionally tolerant of an already-sanitized legacy snapshot so
 * reads can re-sanitize historical rows without exposing private identifiers.
 */
function wfChatProductPublicShareMessages($value): array
{
    if (!is_array($value)) return [];

    $messages = [];
    foreach (array_slice($value, 0, WF_CHAT_PRODUCT_MAX_MESSAGES) as $message) {
        if (!is_array($message)) continue;
        $role = $message['role'] ?? null;
        if ($role === 'ai') $role = 'assistant';
        $content = wfChatProductCleanText(
            $message['content'] ?? ($message['rawContent'] ?? null),
            WF_CHAT_PRODUCT_MAX_MESSAGE_BYTES,
            true
        );
        $createdAt = wfChatProductTimestampMs(
            $message['createdAt'] ?? ($message['created_at'] ?? ($message['timestamp'] ?? null))
        );
        if (!in_array($role, ['user', 'assistant'], true) || $content === null || $createdAt === null) continue;

        $public = [
            'role' => $role,
            'content' => $content,
            'createdAt' => $createdAt,
        ];

        $attachments = [];
        if (is_array($message['attachments'] ?? null)) {
            foreach (array_slice($message['attachments'], 0, WF_CHAT_PRODUCT_MAX_MESSAGE_ATTACHMENTS) as $attachment) {
                if (!is_array($attachment)) continue;
                $name = wfChatProductCleanText($attachment['name'] ?? null, 255, false);
                $mime = is_string($attachment['mime'] ?? null) ? strtolower(trim($attachment['mime'])) : '';
                $size = $attachment['size'] ?? null;
                if ($name === null || $name === ''
                    || preg_match('/^[a-z0-9.+-]+\/[a-z0-9.+-]+$/', $mime) !== 1
                    || !(is_int($size) || (is_string($size) && ctype_digit($size)))
                    || (int)$size < 0 || (int)$size > 10485760) continue;
                $attachments[] = ['name' => $name, 'mime' => $mime, 'size' => (int)$size];
            }
        }
        if ($attachments) $public['attachments'] = $attachments;

        $annotations = [];
        if (is_array($message['annotations'] ?? null)) {
            foreach (array_slice($message['annotations'], 0, WF_CHAT_PRODUCT_MAX_ANNOTATIONS) as $annotation) {
                if (!is_array($annotation)) continue;
                $type = $annotation['type'] ?? null;
                $url = is_string($annotation['url'] ?? null) ? trim($annotation['url']) : '';
                if ($type === 'url_citation' && $url !== '' && strlen($url) <= 2048
                    && filter_var($url, FILTER_VALIDATE_URL) !== false
                    && in_array(strtolower((string)parse_url($url, PHP_URL_SCHEME)), ['http', 'https'], true)) {
                    $item = ['type' => 'url_citation', 'url' => $url];
                    $title = wfChatProductCleanText($annotation['title'] ?? '', 500, false);
                    if ($title !== null && $title !== '') $item['title'] = $title;
                    $annotations[] = $item;
                    continue;
                }
                if (in_array($type, ['file_citation', 'container_file_citation', 'file_path'], true)) {
                    $filename = wfChatProductCleanText($annotation['filename'] ?? '', 255, false);
                    if ($filename !== null && $filename !== '') {
                        $annotations[] = ['type' => 'file_citation', 'filename' => $filename];
                    }
                }
            }
        }
        if ($annotations) $public['annotations'] = $annotations;

        $messages[] = $public;
    }
    return $messages;
}

function wfChatProductConversationIdHash(string $conversationId): string
{
    return hash('sha256', $conversationId);
}

function wfChatProductNormalizePcProfile($value, ?string &$error = null): ?array
{
    $error = null;
    if ($value === null || $value === []) return [];
    if (!is_array($value)) {
        $error = 'invalid_pc_profile';
        return null;
    }
    $allowedStrings = [
        'os_name', 'os_version', 'edition', 'build', 'architecture', 'device_type',
        'manufacturer', 'model', 'cpu', 'gpu',
    ];
    $profile = [];
    foreach ($value as $key => $field) {
        if ($key === 'memory_gb') {
            if (!is_numeric($field) || (float)$field < 0 || (float)$field > 16384) {
                $error = 'invalid_pc_profile';
                return null;
            }
            $profile[$key] = round((float)$field, 2);
            continue;
        }
        if (!in_array($key, $allowedStrings, true)) {
            $error = 'unknown_pc_profile_field';
            return null;
        }
        $clean = wfChatProductCleanText($field, 255, false);
        if ($clean === null) {
            $error = 'invalid_pc_profile';
            return null;
        }
        if ($clean !== '') $profile[$key] = $clean;
    }
    return $profile;
}

function wfChatProductNormalizeIdList($value, callable $validator, int $maxItems = 50): ?array
{
    if ($value === null) return [];
    if (!is_array($value) || count($value) > $maxItems) return null;
    $items = [];
    foreach ($value as $item) {
        $normalized = $validator($item);
        if (!is_string($normalized)) return null;
        $items[$normalized] = true;
    }
    return array_keys($items);
}

function wfChatProductShareLifetime($value): ?int
{
    if ($value === null || $value === '') return WF_CHAT_PRODUCT_SHARE_DEFAULT_SECONDS;
    $seconds = wfChatProductExpectedRevision($value, false);
    if ($seconds === null
        || $seconds < WF_CHAT_PRODUCT_SHARE_MIN_SECONDS
        || $seconds > WF_CHAT_PRODUCT_SHARE_MAX_SECONDS) return null;
    return $seconds;
}

function wfChatProductBase64UrlEncode(string $value): string
{
    return rtrim(strtr(base64_encode($value), '+/', '-_'), '=');
}

function wfChatProductBase64UrlDecode(string $value): ?string
{
    if (preg_match('/^[A-Za-z0-9_-]+$/', $value) !== 1) return null;
    $padding = (4 - strlen($value) % 4) % 4;
    $decoded = base64_decode(strtr($value . str_repeat('=', $padding), '-_', '+/'), true);
    if (!is_string($decoded) || wfChatProductBase64UrlEncode($decoded) !== $value) return null;
    return $decoded;
}

function wfChatProductEncodeCursor(string $scope, int $updatedAtMs, string $id, string $secret): ?string
{
    if ($secret === '' || preg_match('/^[a-z_]{1,32}$/', $scope) !== 1
        || $updatedAtMs < 1 || wfChatProductNormalizeOpaqueId($id, 160) === null) return null;
    $payload = json_encode(['s' => $scope, 't' => $updatedAtMs, 'i' => $id], JSON_UNESCAPED_SLASHES);
    if (!is_string($payload)) return null;
    $signature = hash_hmac('sha256', 'wf-chat-cursor|' . $payload, $secret, true);
    return wfChatProductBase64UrlEncode($payload . $signature);
}

function wfChatProductDecodeCursor($cursor, string $scope, string $secret): ?array
{
    if ($cursor === null || $cursor === '') return [];
    if (!is_string($cursor) || strlen($cursor) > 512 || $secret === '') return null;
    $decoded = wfChatProductBase64UrlDecode($cursor);
    if ($decoded === null || strlen($decoded) <= 32) return null;
    $payload = substr($decoded, 0, -32);
    $signature = substr($decoded, -32);
    $expected = hash_hmac('sha256', 'wf-chat-cursor|' . $payload, $secret, true);
    if (!hash_equals($expected, $signature)) return null;
    $data = json_decode($payload, true);
    if (!is_array($data) || ($data['s'] ?? null) !== $scope
        || !is_int($data['t'] ?? null)
        || wfChatProductNormalizeOpaqueId($data['i'] ?? null, 160) === null) return null;
    return ['updated_at' => $data['t'], 'id' => $data['i']];
}

function wfChatProductTelemetryEvents(): array
{
    return [
        'app_error', 'unhandled_rejection', 'largest_contentful_paint', 'layout_shift', 'navigation',
        'surface_ready', 'starter_selected', 'history_search', 'history_result_opened',
        'sync_failed', 'sync_recovered',
        'chat_send_started', 'chat_first_token', 'chat_completed', 'chat_stopped', 'chat_failed',
        'message_copied', 'message_feedback', 'source_opened', 'conversation_created',
        'conversation_opened', 'conversation_renamed', 'conversation_deleted', 'conversation_exported',
        'attachment_uploaded', 'share_created', 'support_case_created',
        'tts_started', 'tts_completed', 'tts_failed',
    ];
}

function wfChatProductTelemetryOutcome($value): ?string
{
    if ($value === null || $value === '') return null;
    if (!is_string($value)) return null;
    $value = strtolower(trim($value));
    return preg_match('/^[a-z0-9_.-]{1,64}$/', $value) === 1 ? $value : null;
}
