import kleur from 'kleur';

export interface SummaryCoverageRow {
  ide: string;
  sessions: number;
  summaries: number;
}

/**
 * Formats per-IDE turn-summary coverage as `ide summaries/sessions`, joined
 * with ', '. IDEs that record sessions but zero turn summaries are yellowed —
 * that shape means turn_summary never arrives (e.g. a stale bridge plugin).
 */
export function formatSummaryCoverage(rows: SummaryCoverageRow[]): string {
  return rows
    .map((r) => {
      const text = `${r.ide} ${r.summaries}/${r.sessions}`;
      return r.sessions > 0 && r.summaries === 0 ? kleur.yellow(text) : text;
    })
    .join(', ');
}
