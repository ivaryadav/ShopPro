/**
 * server/src/migrationTools/jsonToRelational/reconciliationReport.js
 *
 * Builds the human-readable reconciliation report migrationService
 * produces after every run (dry-run or real). Pure formatting — no I/O.
 */
'use strict';

/**
 * @param {{tenantId:number,dryRun:boolean,startedAt:string,finishedAt:string,
 *   counts:{created:object,skipped:object},skippedDetails:string[],
 *   integrity:{ok:boolean,mismatches:string[]}|null}} result
 * @returns {string} markdown
 */
function renderMarkdown(result) {
  const lines = [];
  lines.push(`# Migration Reconciliation Report — Tenant ${result.tenantId}`);
  lines.push('');
  lines.push(`Mode: **${result.dryRun ? 'DRY RUN (no writes committed)' : 'REAL RUN (rows written)'}**`);
  lines.push(`Started: ${result.startedAt}  Finished: ${result.finishedAt}`);
  lines.push('');
  lines.push('## Rows created (or that would be created, in dry-run)');
  lines.push('');
  lines.push('| Entity | Count |');
  lines.push('|---|---|');
  for (const [k, v] of Object.entries(result.counts.created)) {
    lines.push(`| ${k} | ${v} |`);
  }
  lines.push('');
  const skippedTotal = Object.values(result.counts.skipped).reduce((a, b) => a + b, 0);
  lines.push(`## Skipped records: ${skippedTotal}`);
  if (result.skippedDetails.length) {
    lines.push('');
    result.skippedDetails.forEach((d) => lines.push(`- ${d}`));
  } else {
    lines.push('');
    lines.push('None — every source record was migrated.');
  }
  lines.push('');
  if (result.integrity) {
    lines.push('## Post-migration integrity verification');
    lines.push('');
    lines.push(result.integrity.ok ? '**PASS** — every count and financial total reconciles exactly.' : '**FAIL** — mismatches found:');
    result.integrity.mismatches.forEach((m) => lines.push(`- ${m}`));
  } else {
    lines.push('## Post-migration integrity verification');
    lines.push('');
    lines.push('Not run (dry-run mode — nothing was written to verify).');
  }
  return lines.join('\n') + '\n';
}

module.exports = { renderMarkdown };
