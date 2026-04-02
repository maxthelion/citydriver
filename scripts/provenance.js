import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

export function getHeadCommit(cwd = process.cwd()) {
  try {
    return execSync('git rev-parse HEAD', {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return null;
  }
}

export function describeFixture(path) {
  const absolute = resolve(path);
  const jsonPath = absolute.endsWith('.json') ? absolute : `${absolute}.json`;
  const meta = JSON.parse(readFileSync(jsonPath, 'utf8')).meta || {};
  return { path: jsonPath, meta };
}
