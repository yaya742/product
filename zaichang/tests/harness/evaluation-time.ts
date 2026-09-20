/** Independent arithmetic aid for the evaluator. Converts evidence timestamps,
 * never treats a model's prose as a new event or changes original observations. */
export function verifiedTimeConversions(evidence: unknown, timeZone: string) {
  const formatter = new Intl.DateTimeFormat('sv-SE', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23', timeZoneName: 'longOffset' });
  const serialized = JSON.stringify(evidence);
  const instants = [...new Set(serialized.match(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})/g) || [])];
  return { timeZone, meaning: 'ISO timestamps with Z are UTC; offsets describe the same instant. These deterministic conversions only explain timestamp arithmetic, not additional source facts.', values: instants.filter(value => Number.isFinite(Date.parse(value))).map(original => ({ original, utc: new Date(original).toISOString(), local: formatter.format(new Date(original)).replace('−', '-') })) };
}
