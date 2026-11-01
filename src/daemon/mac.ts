import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);

/** The macOS bits the dashboard can ask the daemon to do. Every command is a fixed string: no arguments come from the hub. */
export interface MacOps {
  /** Turns `pmset disablesleep` on or off. Shows the macOS admin password prompt. */
  setKeepAwake(on: boolean): Promise<void>;
  keepAwake(): Promise<boolean | null>;
  /** Opens System Settings → Privacy & Security → Full Disk Access. */
  openFullDiskAccess(): Promise<void>;
}

export const FDA_SETTINGS_URL = 'x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles';

const PMSET_ON = 'do shell script "/usr/bin/pmset -a disablesleep 1" with administrator privileges';
const PMSET_OFF = 'do shell script "/usr/bin/pmset -a disablesleep 0" with administrator privileges';

export function parseSleepDisabled(pmsetOutput: string): boolean | null {
  const m = /SleepDisabled\s+(\d)/i.exec(pmsetOutput);
  return m ? m[1] === '1' : null;
}

export function macOps(): MacOps {
  return {
    async setKeepAwake(on) {
      // osascript's admin prompt: the password goes to macOS, never through the hub or this process.
      await run('/usr/bin/osascript', ['-e', on ? PMSET_ON : PMSET_OFF], { timeout: 120_000 });
    },
    async keepAwake() {
      try {
        const { stdout } = await run('/usr/bin/pmset', ['-g'], { timeout: 10_000 });
        return parseSleepDisabled(stdout) ?? false;
      } catch {
        return null;
      }
    },
    async openFullDiskAccess() {
      await run('/usr/bin/open', [FDA_SETTINGS_URL], { timeout: 10_000 });
    },
  };
}
