import type { HubConfig } from '../config.js';
import { handleBounces } from '../bounces.js';
import { canSee } from '../scopes.js';
import { sensitiveTopicsIn } from '../guard.js';
import type { Store, TaskRow } from '../store.js';
import { isBounce } from '../transports/imap.js';
import { notConfigured, type Adapter } from './types.js';

const UID_KEY = 'boardy.imap.lastUid';
const VALIDITY_KEY = 'boardy.imap.uidValidity';

/**
 * The brief format from Boardy's official "connect your AI" flow (https://boardy.ai/agents). Boardy
 * reads each heading into his notes, and recognises the user by the From address, so EMAIL_FROM must
 * be the user's own address.
 */
export function composeBoardyBrief(cfg: HubConfig, task: TaskRow, standing: string[]): { subject: string; text: string } {
  const o = cfg.owner;
  const month = new Intl.DateTimeFormat('en-US', { month: 'long', year: 'numeric', timeZone: cfg.timezone }).format(new Date());
  const ask = task.payload.replace(/\s+/g, ' ').trim();
  const subjectAsk = ask.length > 90 ? `${ask.slice(0, 87)}…` : ask;
  const lines = [
    'Hi Boardy,',
    '',
    `I'm ${cfg.ownerName}'s Agent Hub, an AI assistant writing on behalf of ${o.fullName}. ${o.fullName} approved this request.`,
    '',
  ];
  if (o.bio) lines.push('Who they are', o.bio, '');
  if (standing.length) lines.push(`Where things stand (as of ${month})`, ...standing.map((s) => `- ${s}`), '');
  lines.push("Who they'd like to meet", ask);
  if (task.rationale) lines.push(`Why now: ${task.rationale}`);
  lines.push('');
  if (o.offer) lines.push('What they can offer', o.offer, '');
  if (o.keepPrivate) lines.push('Please keep private', o.keepPrivate, '');
  if (o.location) lines.push(`Location: ${o.location}`);
  for (const l of o.links) lines.push(`${l.label}: ${l.url}`);
  lines.push('', 'Could you find people who fit?', '', `${cfg.ownerName}'s Agent Hub, on behalf of ${o.fullName}`);
  return { subject: `Ask Boardy: ${subjectAsk}`, text: lines.join('\n') };
}

/** Professional facts/situation Boardy may see, with anything sensitive removed. */
async function standingFor(store: Store): Promise<string[]> {
  const scope = await store.scope('boardy');
  const denied = new Set(scope?.deny_topics ?? []);
  const items = [...(await store.liveSituation()), ...(await store.activeFacts())]
    .filter((i) => canSee(scope, i.topics))
    .map((i) => i.text)
    .filter((t) => !sensitiveTopicsIn(t).some((s) => denied.has(s)));
  return [...new Set(items)].slice(0, 6);
}

/**
 * Boardy: networking agent. Reads come from the Mac daemon (iMessage/SMS) and from the user's inbox over
 * IMAP (Boardy replies by email). Tasks are sent as the official brief to boardy@boardy.ai.
 */
export const boardy: Adapter = {
  id: 'boardy',
  name: 'Boardy',
  capabilities: {
    profile: 'Networking agent: warm intros, finding people (investors, collaborators, hires), following up on professional connections.',
    readVia: 'imessage',
    deliverVia: 'email',
    canReceiveTasks: true,
  },
  imessageHandles: (cfg) => (cfg.imessageHandles.boardy ? [cfg.imessageHandles.boardy] : []),

  async readEvents(ctx) {
    const imap = ctx.transports.imap;
    if (!imap) return 0;
    const lastUid = await ctx.store.getSetting<number | null>(UID_KEY, null);
    const validity = await ctx.store.getSetting<string | null>(VALIDITY_KEY, null);
    const { messages, uidValidity } = await imap.fetchSince(lastUid ?? 0, validity);
    const maxUid = messages.reduce((m, e) => Math.max(m, e.uid), lastUid ?? 0);
    if (validity !== uidValidity) await ctx.store.setSetting(VALIDITY_KEY, uidValidity);
    if (lastUid === null || validity !== uidValidity) {
      // First run or mailbox reset: start from the current end of the mailbox.
      await ctx.store.setSetting(UID_KEY, maxUid);
      return 0;
    }
    await handleBounces(ctx.store, messages.filter(isBounce), ctx.cfg.delivery);
    const fromBoardy = messages.filter((m) => m.from === ctx.cfg.boardyEmail.toLowerCase() && !isBounce(m));
    const inserted = await ctx.store.insertRawMessages(
      fromBoardy.map((m) => ({
        agent: 'boardy' as const,
        externalId: m.messageId ?? `uid:${uidValidity}:${m.uid}`,
        channel: 'email',
        author: 'agent' as const,
        text: `${m.subject}\n\n${m.text}`.slice(0, 8000),
        sentAt: m.date,
      })),
    );
    await ctx.store.setSetting(UID_KEY, maxUid);
    if (inserted.length) await ctx.store.touchRead('boardy');
    return inserted.length;
  },

  async deliverContext() {
    // Boardy only hears from the hub when there is a concrete ask.
    return { ok: true, detail: 'held: Boardy receives context only with a request' };
  },

  async triggerTask(ctx, task, context) {
    if (!ctx.transports.email) return notConfigured('SMTP not configured (SMTP_URL + EMAIL_FROM)');
    const standing = [...new Set([...context, ...(await standingFor(ctx.store))])].slice(0, 6);
    const brief = composeBoardyBrief(ctx.cfg, task, standing);
    const { messageId } = await ctx.transports.email.send({ to: ctx.cfg.boardyEmail, subject: brief.subject, text: brief.text });
    return { ok: true, detail: `emailed brief to ${ctx.cfg.boardyEmail}`, ref: messageId };
  },

  configured(cfg) {
    const email = Boolean(cfg.email.smtpUrl && cfg.email.from);
    const linkedin = cfg.owner.links.some((l) => /linkedin/i.test(l.label) || /linkedin\.com/i.test(l.url));
    return {
      ok: email && linkedin,
      note: [
        cfg.imessageHandles.boardy ? 'reads via iMessage daemon' : 'no iMessage handle',
        cfg.imap.url ? 'reads replies via IMAP' : 'no IMAP_URL: email replies not read',
        email ? `delivers briefs to ${cfg.boardyEmail}` : 'SMTP not configured: tasks held',
        linkedin ? '' : 'add LinkedIn to OWNER_LINKS (Boardy cannot search without it)',
      ].filter(Boolean).join('; '),
    };
  },
};
