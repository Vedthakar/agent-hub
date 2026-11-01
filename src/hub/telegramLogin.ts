import { randomBytes } from 'node:crypto';

export type TelegramLoginStep =
  | { status: 'code-sent'; loginId: string }
  | { status: 'password-needed'; loginId: string; hint: string | null }
  | { status: 'done'; session: string; account: string }
  | { status: 'error'; message: string };

/** The three-step Telegram user login (phone → code → optional 2FA password), driven from the dashboard. */
export interface TelegramLoginDriver {
  start(apiId: number, apiHash: string, phone: string): Promise<TelegramLoginStep>;
  code(loginId: string, code: string): Promise<TelegramLoginStep>;
  password(loginId: string, password: string): Promise<TelegramLoginStep>;
}

const TTL_MS = 10 * 60_000;

/** Turns gramjs errors into something the owner can act on, without echoing anything they typed. */
function friendly(err: unknown): string {
  const m = String((err as { errorMessage?: string }).errorMessage ?? (err as Error)?.message ?? err);
  if (/PHONE_NUMBER_INVALID/.test(m)) return 'Telegram says that phone number is invalid. Include the country code, e.g. +1 555 123 4567.';
  if (/PHONE_CODE_INVALID/.test(m)) return 'That code is wrong. Check the latest message from Telegram and try again.';
  if (/PHONE_CODE_EXPIRED/.test(m)) return 'That code expired. Start again to get a new one.';
  if (/PASSWORD_HASH_INVALID/.test(m)) return 'Wrong two-step verification password.';
  if (/API_ID_INVALID|API_ID_PUBLISHED_FLOOD/.test(m)) return 'Telegram rejected the API ID / hash. Copy them again from my.telegram.org.';
  if (/FLOOD/.test(m)) return 'Telegram is rate-limiting logins. Wait a few minutes and try again.';
  return 'Telegram login failed. Try again in a minute.';
}

/** The real driver, over MTProto (the `telegram` package). Pending logins live in memory for 10 minutes. */
export function telegramLoginDriver(): TelegramLoginDriver {
  type Pending = {
    client: import('telegram').TelegramClient;
    apiId: number;
    apiHash: string;
    phone: string;
    phoneCodeHash: string;
    timer: NodeJS.Timeout;
  };
  const pending = new Map<string, Pending>();
  const drop = async (id: string) => {
    const p = pending.get(id);
    if (!p) return;
    pending.delete(id);
    clearTimeout(p.timer);
    await p.client.disconnect().catch(() => undefined);
  };
  const finish = async (id: string, p: Pending): Promise<TelegramLoginStep> => {
    const me = (await p.client.getMe()) as { username?: string; firstName?: string };
    const session = String(p.client.session.save());
    await drop(id);
    return { status: 'done', session, account: me.username ? `@${me.username}` : (me.firstName ?? 'your account') };
  };

  return {
    async start(apiId, apiHash, phone) {
      try {
        const { TelegramClient } = await import('telegram');
        const { StringSession } = await import('telegram/sessions/index.js');
        const client = new TelegramClient(new StringSession(''), apiId, apiHash, { connectionRetries: 3 });
        client.setLogLevel('error' as never);
        await client.connect();
        const { phoneCodeHash } = await client.sendCode({ apiId, apiHash }, phone);
        const loginId = randomBytes(12).toString('base64url');
        pending.set(loginId, { client, apiId, apiHash, phone, phoneCodeHash, timer: setTimeout(() => void drop(loginId), TTL_MS).unref() });
        return { status: 'code-sent', loginId };
      } catch (err) {
        return { status: 'error', message: friendly(err) };
      }
    },
    async code(loginId, code) {
      const p = pending.get(loginId);
      if (!p) return { status: 'error', message: 'This login expired. Start again.' };
      try {
        const { Api } = await import('telegram');
        await p.client.invoke(new Api.auth.SignIn({ phoneNumber: p.phone, phoneCodeHash: p.phoneCodeHash, phoneCode: code.replace(/\s/g, '') }));
        return await finish(loginId, p);
      } catch (err) {
        if (/SESSION_PASSWORD_NEEDED/.test(String((err as { errorMessage?: string }).errorMessage ?? err))) {
          return { status: 'password-needed', loginId, hint: null };
        }
        return { status: 'error', message: friendly(err) };
      }
    },
    async password(loginId, password) {
      const p = pending.get(loginId);
      if (!p) return { status: 'error', message: 'This login expired. Start again.' };
      let failure: unknown = null;
      try {
        await p.client.signInWithPassword(
          { apiId: p.apiId, apiHash: p.apiHash },
          {
            password: async () => password,
            onError: async (e) => {
              failure = e;
              return true;
            },
          },
        );
        return await finish(loginId, p);
      } catch (err) {
        return { status: 'error', message: friendly(failure ?? err) };
      }
    },
  };
}
