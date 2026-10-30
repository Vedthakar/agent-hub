import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);

// Handle and body are passed as argv, never interpolated into the script, so message text can't inject AppleScript.
const SCRIPT = `
on run argv
  set targetHandle to item 1 of argv
  set messageText to item 2 of argv
  tell application "Messages"
    set targetService to 1st account whose service type = iMessage
    try
      set targetBuddy to participant targetHandle of targetService
    on error
      set targetBuddy to buddy targetHandle of targetService
    end try
    send messageText to targetBuddy
  end tell
end run`;

/** Sends through Messages.app. Requires the Automation permission for Messages the first time. */
export async function sendIMessage(handle: string, body: string): Promise<void> {
  await run('osascript', ['-e', SCRIPT, handle, body], { timeout: 30_000 });
}
