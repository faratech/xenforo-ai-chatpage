<?php

declare(strict_types=1);

/**
 * Resolve the xf_style id that a src/styles/<dir> template tree feeds.
 *
 * Deterministic in both worlds:
 *   1. If the style row still carries a designer_mode binding to <dir>, that
 *      wins (designer mode enabled again after the 2026-08-22 retirement).
 *   2. Otherwise the tree's committed .wf-style-id marker is used (dotfiles
 *      are skipped by every XF designer walker, so the marker is inert to
 *      XenForo itself).
 * Any conflict between the two sources, or an unknown style id, fails closed.
 *
 * Callers must have booted \XF first.
 *
 * @return int style id
 */
function wf_resolve_style_id(string $stylesRoot, string $dir): int
{
	if (!preg_match('/^[a-z0-9_]+$/i', $dir))
	{
		fwrite(STDERR, "Invalid style directory name '{$dir}'\n");
		exit(2);
	}

	$db = \XF::db();

	$flagRows = $db->fetchAll(
		'SELECT style_id FROM xf_style WHERE designer_mode = ?',
		$dir
	);
	$flagId = count($flagRows) === 1 ? (int)$flagRows[0]['style_id'] : null;

	$markerPath = rtrim($stylesRoot, DIRECTORY_SEPARATOR) . DIRECTORY_SEPARATOR . $dir . DIRECTORY_SEPARATOR . '.wf-style-id';
	$markerRaw = is_file($markerPath) ? trim((string)file_get_contents($markerPath)) : '';
	$markerId = preg_match('/^\d+$/', $markerRaw) ? (int)$markerRaw : null;

	if ($flagId !== null && $markerId !== null && $flagId !== $markerId)
	{
		fwrite(STDERR, "Style dir '{$dir}': designer_mode binds style {$flagId} but marker says {$markerId}\n");
		exit(1);
	}
	$styleId = $flagId ?? $markerId;
	if ($styleId === null)
	{
		fwrite(STDERR, "Style dir '{$dir}': no designer_mode binding and no readable {$markerPath}\n");
		exit(1);
	}

	$exists = $db->fetchOne('SELECT COUNT(*) FROM xf_style WHERE style_id = ?', $styleId);
	if (!$exists)
	{
		fwrite(STDERR, "Style dir '{$dir}' resolves to style {$styleId}, which does not exist\n");
		exit(1);
	}

	return $styleId;
}

/** Derive deploy consumers from live styles, ignoring retired source trees. */
function wf_chat_style_manifest(string $stylesRoot): array
{
	$rows = \XF::db()->fetchAll('SELECT style_id, designer_mode FROM xf_style');
	$existing = array_map(static fn(array $row): int => (int)$row['style_id'], $rows);
	$styles = [];
	foreach (['wf3', 'wf3_domperf', 'wf5'] as $dir)
	{
		$marker = $stylesRoot . '/' . $dir . '/.wf-style-id';
		$raw = is_file($marker) ? trim((string)file_get_contents($marker)) : '';
		$bound = array_filter($rows, static fn(array $row): bool => $row['designer_mode'] === $dir);
		// An unbound directory whose style was deleted is historical input.
		if (!$bound && preg_match('/^\d+$/', $raw) && !in_array((int)$raw, $existing, true)) continue;
		$styles[$dir] = wf_resolve_style_id($stylesRoot, $dir);
	}
	if (!isset($styles['wf3'])) throw new \RuntimeException('Canonical wf3 chat style is missing');
	return ['styles' => $styles, 'existing' => $existing];
}
