/**
 * One-time login that prints TELEGRAM_SESSION for the Stanley adapter.
 * Needs TELEGRAM_API_ID / TELEGRAM_API_HASH from https://my.telegram.org.
 */
import 'dotenv/config';
import readline from 'node:readline/promises';
import { TelegramClient } from 'telegram';
import { StringSession } from 'telegram/sessions/index.js';

const apiId = Number(process.env.TELEGRAM_API_ID);
const apiHash = process.env.TELEGRAM_API_HASH ?? '';
if (!apiId || !apiHash) throw new Error('Set TELEGRAM_API_ID and TELEGRAM_API_HASH first');

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const client = new TelegramClient(new StringSession(''), apiId, apiHash, { connectionRetries: 5 });
await client.start({
  phoneNumber: () => rl.question('Phone number: '),
  password: () => rl.question('2FA password (if any): '),
  phoneCode: () => rl.question('Code from Telegram: '),
  onError: (err) => console.error(err),
});
console.log('\nTELEGRAM_SESSION=' + client.session.save());
rl.close();
await client.disconnect();
process.exit(0);
