import type { HubConfig } from '../config.js';

export interface InboundEmail {
  uid: number;
  messageId: string | null;
  from: string;
  subject: string;
  text: string;
  date: Date;
  /** Message-IDs this email references (In-Reply-To / References / quoted in a bounce body). */
  refs: string[];
}

export interface ImapTransport {
  /** New messages after `lastUid` (UIDs are only comparable within one `uidValidity`). */
  fetchSince(lastUid: number, uidValidity: string | null): Promise<{ messages: InboundEmail[]; uidValidity: string }>;
}

const MESSAGE_ID = /<[^<>\s@]+@[^<>\s]+>/g;

/** Read-only IMAP poller for the user's inbox (Boardy's replies and delivery bounces). */
export function createImap(cfg: HubConfig['imap']): ImapTransport | null {
  if (!cfg.url) return null;
  const url = new URL(cfg.url);
  return {
    async fetchSince(lastUid, knownValidity) {
      const { ImapFlow } = await import('imapflow');
      const { simpleParser } = await import('mailparser');
      const client = new ImapFlow({
        host: url.hostname,
        port: Number(url.port || (url.protocol === 'imaps:' ? 993 : 143)),
        secure: url.protocol === 'imaps:',
        auth: { user: decodeURIComponent(url.username), pass: decodeURIComponent(url.password) },
        logger: false,
      });
      await client.connect();
      const lock = await client.getMailboxLock(cfg.mailbox, { readOnly: true });
      try {
        const box = client.mailbox;
        const uidValidity = String(box && typeof box === 'object' ? box.uidValidity : '0');
        // UIDVALIDITY changed: old UIDs are meaningless. Start from the current end instead of re-reading everything.
        if (knownValidity && knownValidity !== uidValidity) return { messages: [], uidValidity };
        const messages: InboundEmail[] = [];
        for await (const msg of client.fetch(`${lastUid + 1}:*`, { uid: true, source: true }, { uid: true })) {
          if (msg.uid <= lastUid || !msg.source) continue;
          const parsed = await simpleParser(msg.source);
          const text = parsed.text ?? '';
          const refs = new Set<string>();
          for (const r of [parsed.inReplyTo ?? '', ...(Array.isArray(parsed.references) ? parsed.references : [parsed.references ?? ''])]) {
            for (const m of String(r).match(MESSAGE_ID) ?? []) refs.add(m);
          }
          for (const m of text.match(MESSAGE_ID) ?? []) refs.add(m);
          messages.push({
            uid: msg.uid,
            messageId: parsed.messageId ?? null,
            from: parsed.from?.value?.[0]?.address?.toLowerCase() ?? '',
            subject: parsed.subject ?? '',
            text,
            date: parsed.date ?? new Date(),
            refs: [...refs],
          });
          if (messages.length >= 200) break;
        }
        return { messages, uidValidity };
      } finally {
        lock.release();
        await client.logout().catch(() => {});
      }
    },
  };
}

const BOUNCE_SENDER = /^(mailer-daemon|postmaster)@/i;
const BOUNCE_SUBJECT = /(undeliver|delivery status notification|failure notice|returned mail|mail delivery (failed|subsystem)|delivery has failed)/i;

export function isBounce(m: InboundEmail): boolean {
  return BOUNCE_SENDER.test(m.from) || BOUNCE_SUBJECT.test(m.subject);
}
