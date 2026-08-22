<?php

declare(strict_types=1);

/**
 * Keep an explicitly selected XenForo style on the stable chat asset contract.
 *
 * Designer-mode styles are imported from src/styles by deploy.sh, but the
 * legacy user-selectable style is database-owned. WF5 is designer-managed, but
 * deploys must update only its two chat bootstrap templates rather than sweep
 * unrelated designer files. The optional profile and expected designer mode
 * make that narrow operation explicit and fail closed.
 *
 * Usage:
 *   php sync-xenforo-db-style.php <xenforo-root> <template-source-dir> <style-id> [full|bootstrap] [expected-designer-mode|auto]
 *
 *   Pass 'auto' as expected-designer-mode to accept the style's current
 *   designer state either way (styles are migrating out of designer mode).
 */

if (PHP_SAPI !== 'cli')
{
	fwrite(STDERR, "CLI only\n");
	exit(2);
}

$xenForoRoot = $argv[1] ?? '';
$sourceDir = $argv[2] ?? '';
$styleId = isset($argv[3]) ? (int)$argv[3] : 0;
$profile = $argv[4] ?? 'full';
$expectedDesignerMode = $argv[5] ?? '';

$xenForoRoot = realpath($xenForoRoot) ?: '';
$sourceDir = realpath($sourceDir) ?: '';
if ($xenForoRoot === '' || !is_file($xenForoRoot . '/src/XF.php'))
{
	fwrite(STDERR, "Invalid XenForo root\n");
	exit(2);
}
if ($sourceDir === '' || !is_dir($sourceDir) || $styleId < 1)
{
	fwrite(STDERR, "Usage: php sync-xenforo-db-style.php <xenforo-root> <template-source-dir> <style-id> [full|bootstrap] [expected-designer-mode]\n");
	exit(2);
}

$templates = match ($profile)
{
	'full' => [
		'_page_node.313' => '_page_node.313',
		'_widget_ai_chat' => '_widget_ai_chat.html',
		'react_chat_container' => 'react_chat_container.html',
	],
	'bootstrap' => [
		'_page_node.313' => '_page_node.313',
		'_widget_ai_chat' => '_widget_ai_chat.html',
	],
	default => null,
};
if ($templates === null)
{
	fwrite(STDERR, "Unknown chat template profile: {$profile}\n");
	exit(2);
}
$sources = [];
foreach ($templates as $title => $fileName)
{
	$path = $sourceDir . DIRECTORY_SEPARATOR . $fileName;
	$contents = is_file($path) ? file_get_contents($path) : false;
	if ($contents === false)
	{
		fwrite(STDERR, "Cannot read canonical template source: {$path}\n");
		exit(1);
	}
	$sources[$title] = $contents;
}

require $xenForoRoot . '/src/XF.php';

\XF::start($xenForoRoot);
\XF::setupApp('XF\\Pub\\App');

$app = \XF::app();
$style = $app->em()->find('XF:Style', $styleId);
if (!$style)
{
	fwrite(STDERR, "XenForo style {$styleId} does not exist\n");
	exit(1);
}
if ($expectedDesignerMode === 'auto')
{
	// Designer-state agnostic: styles are migrating out of designer mode, and
	// the scoped chat-template write is correct whether the flag is set or
	// NULL. Only a mismatched binding would be suspicious.
	if ($style->designer_mode !== null)
	{
		fwrite(STDOUT, "Style {$styleId} is designer-managed as '{$style->designer_mode}'; syncing anyway (auto mode).\n");
	}
}
elseif ($expectedDesignerMode !== '')
{
	if ($style->designer_mode !== $expectedDesignerMode)
	{
		fwrite(STDERR, "Refusing scoped sync: style {$styleId} is not designer mode {$expectedDesignerMode}\n");
		exit(1);
	}
}
elseif ($style->designer_mode)
{
	fwrite(STDERR, "Refusing database sync for designer-managed style {$styleId}\n");
	exit(1);
}

$changed = 0;
$recompiled = 0;
foreach ($sources as $title => $contents)
{
	$template = $app->finder('XF:Template')
		->where([
			'style_id' => $styleId,
			'type' => 'public',
			'title' => $title,
		])
		->fetchOne();

	if (!$template)
	{
		$template = $app->em()->create('XF:Template');
		$template->style_id = $styleId;
		$template->type = 'public';
		$template->title = $title;
	}

	if ($template->template !== $contents)
	{
		$template->template = $contents;
		$template->save();
		$changed++;
	}
	else
	{
		// Compiled templates live on node-local storage. The database row may
		// already have replicated from the other node, so explicitly compile an
		// unchanged row on this node as part of every deployment.
		$app->service(\XF\Service\Template\CompileService::class)->recompile($template);
		$recompiled++;
	}
}

fwrite(
	STDOUT,
	"Synchronized " . count($templates) . " chat templates for database style {$styleId} "
		. "({$changed} changed, {$recompiled} recompiled).\n"
);
