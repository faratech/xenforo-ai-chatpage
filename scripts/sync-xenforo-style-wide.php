<?php

declare(strict_types=1);

/**
 * Style-wide disk-to-database template sync that does not require designer
 * mode.
 *
 * Historically deploy.sh pushed template sources into XenForo with
 * `xf-designer:import-templates <id>` plus `rebuild-metadata`, both of which
 * hard-require the target style to be designer-managed. Styles are migrating
 * out of designer mode, so this reproduces exactly that operation using the
 * same XF\DesignerOutput services, keyed by an explicit designer directory id
 * instead of the style row's flag:
 *
 *   - every file under src/styles/<id>/templates/ is imported (create/update,
 *     compile included) through XF\DesignerOutput\Template::import(), with
 *     titles/types derived by convertTemplateFileToName() — identical to the
 *     stock command, including legacy titles that embed ".css";
 *   - DB rows whose file disappeared are deleted, mirroring the stock
 *     deleteRemaining() behaviour;
 *   - templates/_metadata.json is rebuilt afterwards, mirroring
 *     `xf-designer:rebuild-metadata`.
 *
 * Usage:
 *   php sync-xenforo-style-wide.php <xenforo-root> <designer-dir-id> [style-id]
 *
 * The target style is auto-detected (designer_mode binding if present, else
 * the tree's committed .wf-style-id marker — see lib/xenforo-style-id.php).
 * Passing [style-id] explicitly turns detection into a cross-check and fails
 * closed on any disagreement.
 */

if (PHP_SAPI !== 'cli')
{
	fwrite(STDERR, "CLI only\n");
	exit(2);
}

$xenForoRoot = realpath($argv[1] ?? '') ?: '';
$designerId = $argv[2] ?? '';
$explicitStyleId = isset($argv[3]) ? (int)$argv[3] : 0;

if ($xenForoRoot === '' || !is_file($xenForoRoot . '/src/XF.php'))
{
	fwrite(STDERR, "Invalid XenForo root\n");
	exit(2);
}
if ($designerId === '' || !preg_match('/^[a-z0-9_]+$/i', $designerId) || $explicitStyleId < 0)
{
	fwrite(STDERR, "Usage: php sync-xenforo-style-wide.php <xenforo-root> <designer-dir-id> [style-id]\n");
	exit(2);
}

require $xenForoRoot . '/src/XF.php';

\XF::start($xenForoRoot);
\XF::setupApp('XF\\Pub\\App');

require __DIR__ . '/lib/xenforo-style-id.php';
$styleId = wf_resolve_style_id($xenForoRoot . '/src/styles', $designerId);
if ($explicitStyleId > 0 && $explicitStyleId !== $styleId)
{
	fwrite(STDERR, "Refusing: style dir '{$designerId}' resolves to {$styleId}, not the requested {$explicitStyleId}\n");
	exit(1);
}

$app = \XF::app();
$style = $app->em()->find('XF:Style', $styleId);
if (!$style)
{
	fwrite(STDERR, "XenForo style {$styleId} does not exist\n");
	exit(1);
}
if ($style->designer_mode !== null && $style->designer_mode !== $designerId)
{
	fwrite(STDERR, "Refusing: style {$styleId} is bound to designer dir '{$style->designer_mode}', not '{$designerId}'\n");
	exit(1);
}

$designerOutput = $app->designerOutput();
$metadata = $designerOutput->getMetadata('templates', $designerId);
$files = $designerOutput->getAvailableTypeFiles('templates', $designerId);
if (!$files)
{
	fwrite(STDERR, "No template files found for designer dir '{$designerId}'\n");
	exit(1);
}

/** @var \XF\DesignerOutput\Template $handler */
$handler = $designerOutput->getHandler('XF:Template');
$map = \XF::db()->fetchPairs("
	SELECT CONCAT(type, '/', title), template_id
	FROM xf_template
	WHERE style_id = ?
", $styleId);

$changed = 0;
$unchanged = 0;
foreach ($files AS $fileName => $path)
{
	$name = $handler->convertTemplateFileToName($fileName);
	$content = file_get_contents($path);
	if ($content === false)
	{
		fwrite(STDERR, "Cannot read {$path}\n");
		exit(1);
	}

	$template = $handler->import($name, $styleId, $content, $metadata[$fileName] ?? [], [
		'import' => true,
	]);

	$key = "{$template->type}/{$template->title}";
	unset($map[$key]);
	if ((int)($template->getExistingValue('template_id')) > 0 && !$template->isChanged('template'))
	{
		$unchanged++;
	}
	else
	{
		$changed++;
	}
}

// Files removed from the tree since the last sync: mirror the stock command
// and delete their rows rather than leaving orphans behind.
$removed = 0;
if ($map)
{
	$old = \XF::em()->findByIds('XF:Template', $map);
	foreach ($old AS $entity)
	{
		$entity->delete();
		$removed++;
	}
}

$designerOutput->rebuildTypeMetadata('templates', $designerId);

\XF::triggerRunOnce();

fwrite(
	STDOUT,
	"Style {$styleId} ('{$style->title}') synced from designer dir '{$designerId}': "
		. count($files) . " files, {$changed} changed, {$unchanged} unchanged, {$removed} removed.\n"
);
