import { randomBytes } from 'node:crypto';
import type { HubConfig } from '../config.js';

export interface EmailTransport {
  /** Resolves once the SMTP server accepted the message. Bounces arrive later via the IMAP reader. */
  send(msg: { to: string; subject: string; text: string }): Promise<{ messageId: string }>;
}

/** SMTP_URL works with any provider, e.g. smtps://user:app-password@smtp.gmail.com:465 or Resend's SMTP relay. */
export function createEmail(cfg: HubConfig['email']): EmailTransport | null {
  if (!cfg.smtpUrl || !cfg.from) return null;
  let transporter: import('nodemailer').Transporter | null = null;
  const domain = cfg.from.split('@')[1]?.replace(/[>\s]/g, '') || 'agent-hub.local';
  return {
    async send(msg) {
      if (!transporter) {
        const nodemailer = await import('nodemailer');
        transporter = nodemailer.createTransport(cfg.smtpUrl!);
      }
      // Our own Message-ID so bounces (which quote it) can be matched back to the task.
      const messageId = `<hub.${Date.now()}.${randomBytes(6).toString('hex')}@${domain}>`;
      await transporter.sendMail({ from: cfg.from!, to: msg.to, subject: msg.subject, text: msg.text, messageId });
      return { messageId };
    },
  };
}

export async function checkEmailLogin(smtpUrl: string): Promise<'ok' | 'rejected' | 'unknown'> {
  const nodemailer = await import('nodemailer');
  const transporter = nodemailer.createTransport(smtpUrl);
  try {
    await transporter.verify();
    return 'ok';
  } catch (err) {
    return (err as { code?: string }).code === 'EAUTH' ? 'rejected' : 'unknown';
  } finally {
    transporter.close();
  }
}
