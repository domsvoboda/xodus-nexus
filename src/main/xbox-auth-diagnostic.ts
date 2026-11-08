/** Xbox error frames carry fixed stage names, HTTP status and one numeric code.
 * They never carry response text, identifiers, URLs or credentials. */
export const xboxAuthOperations = new Set(['profile', 'library', 'streaming', 'download', 'license', 'run', 'service', 'social']);
export const xboxAuthStages = new Set(['xbox-user', 'xbox-xsts'].flatMap(stage =>
  ['http', 'response', 'connect', 'timeout', 'request'].map(kind => `${stage}-${kind}`)));

export function xboxAuthDiagnostic(line: string): { stage: string; status?: number; serviceCode?: string } | undefined {
  const match = /^NEXUS_XBOX_AUTH_DIAGNOSTIC_V1 (xbox-(?:user|xsts)-(http|response|connect|timeout|request)) (0|[1-5][0-9]{2}) ([A-F0-9]{8})$/.exec(line);
  if (!match) return;
  const status = Number(match[3]);
  if (match[2] === 'http' ? status < 400 : match[2] === 'response' ? status < 100 || status >= 400 : status !== 0) return;
  if (match[2] !== 'http' && match[4] !== '00000000') return;
  return { stage: match[1], status: status || undefined, serviceCode: match[4] === '00000000' ? undefined : match[4] };
}
