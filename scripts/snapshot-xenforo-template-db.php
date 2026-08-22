<?php

declare(strict_types=1);

/**
 * Snapshot the currently live XenForo chat templates from the database.
 *
 * Designer source files can contain a pending release that has not been
 * imported yet, so they are not a safe rollback source. This helper captures
 * the authoritative pre-import rows into the bundle layout consumed by
 * deploy.sh.
 *
 * Usage:
 *   php snapshot-xenforo-template-db.php <xenforo-root> <output-root>
 *
 * Style ids are auto-detected per source dir (designer_mode binding if
 * present, else the tree's .wf-style-id marker — see lib/xenforo-style-id.php).
 */

if (PHP_SAPI !== 'cli')
{
	fwrite(STDERR, "CLI only\n");
	exit(2);
}

$xenForoRoot = $argv[1] ?? '';
$outputRoot = $argv[2] ?? '';
if ($xenForoRoot === '' || $outputRoot === '')
{
	fwrite(STDERR, "Usage: php snapshot-xenforo-template-db.php <xenforo-root> <output-root>\n");
	exit(2);
}

$xenForoRoot = realpath($xenForoRoot) ?: '';
if ($xenForoRoot === '' || !is_file($xenForoRoot . '/src/XF.php'))
{
	fwrite(STDERR, "Invalid XenForo root\n");
	exit(2);
}

require $xenForoRoot . '/src/XF.php';

\XF::start($xenForoRoot);
\XF::setupApp('XF\\Pub\\App');

$fullTemplates = [
	'_page_node.313' => '_page_node.313',
	'_widget_ai_chat' => '_widget_ai_chat.html',
	'react_chat_container' => 'react_chat_container.html',
];
$bootstrapTemplates = [
	'_page_node.313' => '_page_node.313',
	'_widget_ai_chat' => '_widget_ai_chat.html',
];
$designers = [
	'wf3' => $fullTemplates,
	'wf3_domperf' => $fullTemplates,
	// WF5 rollback is deliberately limited to the two chat bootstrap templates.
	'wf5' => $bootstrapTemplates,
];
$db = \XF::db();
$written = 0;

require __DIR__ . '/lib/xenforo-style-id.php';

foreach ($designers AS $designer => $templates)
{
	$styleId = wf_resolve_style_id($xenForoRoot . '/src/styles', $designer);

	$designerOutput = rtrim($outputRoot, DIRECTORY_SEPARATOR) . DIRECTORY_SEPARATOR . $designer;
	if (!is_dir($designerOutput) && !mkdir($designerOutput, 0755, true) && !is_dir($designerOutput))
	{
		fwrite(STDERR, "Cannot create {$designerOutput}\n");
		exit(1);
	}

	foreach ($templates AS $title => $fileName)
	{
		$rows = $db->fetchAll(
			'SELECT template FROM xf_template WHERE style_id = ? AND type = ? AND title = ?',
			[$styleId, 'public', $title]
		);
		if (count($rows) !== 1)
		{
			fwrite(STDERR, "Expected one public:{$title} row for {$designer} (style {$styleId})\n");
			exit(1);
		}

		$destination = $designerOutput . DIRECTORY_SEPARATOR . $fileName;
		if (file_put_contents($destination, $rows[0]['template'], LOCK_EX) === false)
		{
			fwrite(STDERR, "Cannot write {$destination}\n");
			exit(1);
		}
		chmod($destination, 0644);
		$written++;
	}
}

fwrite(STDOUT, "Snapshotted {$written} authoritative XenForo template rows.\n");
