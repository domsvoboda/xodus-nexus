import { createHash } from 'node:crypto';
import path from 'node:path';

/** Short stable id of a Nexus profile (its userData directory); names shortcuts, units and sockets. */
export function profileIdOf(userData: string): string {
  return createHash('sha256').update(path.resolve(userData)).digest('hex').slice(0, 12);
}
