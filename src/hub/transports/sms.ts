import { createHmac } from 'node:crypto';
import type { HubConfig } from '../config.js';
import { safeEqual } from '../crypto.js';

export interface SmsTransport {
  send(text: string): Promise<void>;
}

/** The hub's own phone number (Twilio). Approval texts come *from* the hub, replies come from the user's phone. */
export function createSms(cfg: HubConfig['approval']['twilio']): SmsTransport | null {
  if (!cfg.accountSid || !cfg.authToken || !cfg.from || !cfg.userNumber) return null;
  return {
    async send(text) {
      const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${cfg.accountSid}/Messages.json`, {
        method: 'POST',
        headers: {
          authorization: `Basic ${Buffer.from(`${cfg.accountSid}:${cfg.authToken}`).toString('base64')}`,
          'content-type': 'application/x-www-form-urlencoded',
        },
        body: new URLSearchParams({ From: cfg.from!, To: cfg.userNumber!, Body: text }),
        signal: AbortSignal.timeout(15_000),
      });
      if (!res.ok) throw new Error(`twilio ${res.status}`);
    },
  };
}

/** https://www.twilio.com/docs/usage/security#validating-requests */
export function twilioSignature(authToken: string, url: string, params: Record<string, string>): string {
  const data = url + Object.keys(params).sort().map((k) => k + params[k]).join('');
  return createHmac('sha1', authToken).update(data).digest('base64');
}

export function verifyTwilio(authToken: string, url: string, params: Record<string, string>, signature: string | undefined): boolean {
  if (!signature) return false;
  return safeEqual(twilioSignature(authToken, url, params), signature);
}
