<?php

declare(strict_types=1);

if (PHP_SAPI !== 'cli') { http_response_code(404); exit(2); }
$root = realpath($argv[1] ?? '') ?: '';
if (!is_file($root . '/src/XF.php')) { fwrite(STDERR, "Invalid XenForo root\n"); exit(2); }
require $root . '/src/XF.php';
\XF::start($root);
\XF::setupApp('XF\\Pub\\App');
require __DIR__ . '/lib/xenforo-style-id.php';
echo json_encode(wf_chat_style_manifest($root . '/src/styles'), JSON_THROW_ON_ERROR) . "\n";
