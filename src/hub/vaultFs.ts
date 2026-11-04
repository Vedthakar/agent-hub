/**
 * Safe file writes for a vault other programs (Obsidian, sync tools) also touch.
 * Adapted from Open Second Brain (MIT), src/core/fs-atomic.ts and src/core/path-safety.ts:
 * https://github.com/itechmeat/open-second-brain. See THIRD_PARTY_NOTICES.md.
 */
import { randomBytes } from 'node:crypto';
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, realpathSync, renameSync, unlinkSync, writeSync } from 'node:fs';
import path from 'node:path';

const inside = (target: string, root: string) => target === root || target.startsWith(root.endsWith(path.sep) ? root : root + path.sep);

function deepestExistingAncestor(target: string): string {
  let cur = target;
  while (!existsSync(cur)) {
    const parent = path.dirname(cur);
    if (parent === cur) return cur;
    cur = parent;
  }
  return cur;
}

/** Throws unless `target` is inside `vault`, both as written and after following symlinks. Returns the resolved path. */
export function ensureInsideVault(target: string, vault: string): string {
  const resolved = path.resolve(target);
  const root = path.resolve(vault);
  if (!inside(resolved, root)) throw new Error(`path escapes vault: ${target}`);
  if (existsSync(root) && !inside(realpathSync(deepestExistingAncestor(resolved)), realpathSync(root))) {
    throw new Error(`path escapes vault via symlink: ${target}`);
  }
  return resolved;
}

/** Temp file, fsync, rename: an interrupted write leaves the old note or the new one, never half of one. Returns false if unchanged. */
export function atomicWrite(target: string, contents: string): boolean {
  if (existsSync(target) && readFileSync(target, 'utf8') === contents) return false;
  const dir = path.dirname(target);
  mkdirSync(dir, { recursive: true });
  const tmp = path.join(dir, `.${path.basename(target)}.${randomBytes(4).toString('hex')}.tmp`);
  const fd = openSync(tmp, 'w', 0o600);
  try {
    writeSync(fd, contents);
    fsyncSync(fd);
  } catch (err) {
    closeSync(fd);
    unlinkSync(tmp);
    throw err;
  }
  closeSync(fd);
  renameSync(tmp, target);
  const dirFd = openSync(dir, 'r');
  fsyncSync(dirFd);
  closeSync(dirFd);
  return true;
}
