import { afterEach, describe, expect, it, vi } from 'vitest';
import { situationFor } from '../../src/hub/context.js';
import { startOfLocalDay } from '../../src/hub/tz.js';
import { HANDLES, INSTINCT_EMAIL, STANLEY_ENV } from '../helpers.js';
import { stack, type Stack } from './stack.js';
import { cite } from '../support/cite.js';

/**
 * The four spec scenarios, end to end on local Supabase. LLM replies are scripted per step (the router's
 * extraction quality is covered by the golden tests); each step also asserts what the router was shown.
 */

const TZ = 'America/New_York';
let s: Stack;
afterEach(async () => {
  vi.useRealTimers();
  await s?.close();
});

const codeIn = (text: string) => text.match(/\[([A-Z2-9]{4})\]/)?.[1] ?? null;
const inDays = (d: number) => new Date(Date.now() + d * 24 * 3600_000).toISOString();

describe('scenario (a): nightly debrief', () => {
  it('emails Instinct a digest of today, and next morning get_situation returns the plan', async () => {
    s = await stack(STANLEY_ENV);
    const claude = await s.mcp('claude-token');

    // Earlier today: a Claude session and a chat with Stanley.
    s.worker.next.push((user) => {
      expect(user).toContain('CONVERSATION SOURCE: claude');
      return { summary: 'Ved outlined the Agent Hub launch post with Claude.', topics: ['projects', 'content'] };
    });
    await claude('log_session', { summary: 'Outlined the launch post for Agent Hub', decisions: ['Post on Monday'] });
    s.say(HANDLES.stanley, 'Any hook ideas for the launch video?');
    s.say(HANDLES.stanley, 'Open with the before/after of your messy agent setup.', false);
    await s.poll();
    s.worker.next.push((user) => {
      expect(user).toContain('Stanley: Open with the before/after');
      return { summary: 'Stanley suggested opening the launch video with a before/after of the agent setup.', topics: ['content'] };
    });
    await s.settle();

    // 10pm: Ved starts the debrief in his own Instinct thread.
    s.say(HANDLES.instinct, "ok let's do the debrief");
    await s.poll();
    await s.hub.idle();
    await s.hub.tick();

    expect(s.email.sent).toHaveLength(1);
    const digest = s.email.sent[0];
    expect(digest.to).toBe(INSTINCT_EMAIL);
    expect(digest.subject).toBe("Ved's day so far (for tonight's debrief)");
    expect(digest.text).toContain('Claude: Ved outlined the Agent Hub launch post with Claude.');
    expect(digest.text).toContain('Stanley: Stanley suggested opening the launch video');
    expect(s.textsIntoAgentThreads()).toEqual([]);

    // The debrief conversation itself.
    s.say(HANDLES.instinct, 'Got it. What are the three things for tomorrow?', false);
    s.say(HANDLES.instinct, 'Study 9-11, shoot the launch video at 3, gym at 6');
    s.say(HANDLES.instinct, 'Locked in. Want Stanley to prep a shot list?', false);
    s.say(HANDLES.instinct, 'yes');
    await s.poll();

    const tomorrow = startOfLocalDay(new Date(Date.now() + 26 * 3600_000), TZ);
    const tomorrowEnd = startOfLocalDay(new Date(tomorrow.getTime() + 26 * 3600_000), TZ);
    s.worker.next.push((user) => {
      expect(user).toContain('MODE: NIGHTLY DEBRIEF');
      expect(user).toContain('Ved: Study 9-11, shoot the launch video at 3, gym at 6');
      // The digest the hub emailed is not part of the conversation being routed.
      expect(user).not.toContain("Ved's day so far");
      const evidence = cite(user, 'Study 9-11, shoot the launch video at 3, gym at 6');
      expect(evidence).toHaveLength(1);
      const plan = (text: string, topics: string[]) => ({ text, slot: `plan:${tomorrow.toISOString().slice(0, 10)}`, topics: ['plan', ...topics], valid_from: tomorrow.toISOString(), expires_at: tomorrowEnd.toISOString(), evidence });
      return {
        summary: 'Nightly debrief: Ved planned study, a launch-video shoot and the gym for tomorrow.',
        topics: ['plan'],
        situation: [plan('Tomorrow 9–11am: study for the midterm', ['school']), plan('Tomorrow 3pm: shoot the launch video', ['shoots']), plan('Tomorrow 6pm: gym', ['health'])],
        tasks: [{ target_agent: 'stanley', payload: 'Prepare a shot list for tomorrow’s 3pm launch-video shoot.', topics: ['shoots', 'content'], evidence: [...evidence, ...cite(user, 'yes')] }],
      };
    });
    await s.settle();
    const [shotList] = await s.store.tasksByStatus(['proposed']);
    expect(shotList.target_agent).toBe('stanley');

    // Not live tonight.
    expect(await claude('get_situation')).not.toContain('launch video at 3');

    // Next morning, 8am.
    vi.useFakeTimers({ toFake: ['Date'], now: new Date(tomorrow.getTime() + 8 * 3600_000) });
    const morning = await claude('get_situation');
    expect(morning).toContain('Tomorrow 9–11am: study for the midterm (via Instinct, you said');
    expect(morning).toContain('Tomorrow 3pm: shoot the launch video');
    expect(morning).toContain('Tomorrow 6pm: gym');
    // Stanley only gets the shoot; Boardy gets none of it.
    expect((await situationFor(s.store, 'stanley')).situation.map((x) => x.text)).toEqual(['Tomorrow 3pm: shoot the launch video']);
    expect((await situationFor(s.store, 'boardy')).situation).toEqual([]);
  });
});

describe('scenario (b): "pause open source for a week"', () => {
  it('creates a Grok Bot task that waits for a coded approval before Grok sees anything', async () => {
    s = await stack();
    const grok = await s.mcp('grok-token');

    s.say(HANDLES.instinct, "Let's pause open source for a week, I need to focus on the assessment");
    s.say(HANDLES.instinct, "Done. I'll let your Grok bot know.", false);
    await s.poll();
    s.worker.next.push((user) => {
      expect(user).toContain("Ved: Let's pause open source for a week");
      const evidence = cite(user, "Let's pause open source");
      return {
        summary: 'Ved paused open-source work for a week to focus on an assessment.',
        topics: ['open_source', 'work'],
        situation: [{ text: 'Open-source work paused for a week', slot: 'pause:open_source', topics: ['open_source'], expires_at: inDays(7), evidence }],
        tasks: [{ target_agent: 'grok', payload: 'Pause all open-source issue triage and PR reviews for one week.', rationale: 'Ved decided this with Instinct', topics: ['open_source', 'work'], evidence }],
      };
    });
    await s.settle();

    const [task] = await s.store.tasksByStatus(['proposed']);
    expect([task.origin_agent, task.target_agent, task.hop]).toEqual(['instinct', 'grok', 1]);
    await s.poll(); // the daemon sends the approval text
    expect(s.texts).toHaveLength(1);
    expect(s.texts[0].handle).toBe(HANDLES.approval);
    expect(codeIn(s.texts[0].body)).toBe(task.code);

    // Waiting: nothing reaches Grok yet, even after more ticks.
    await s.hub.tick();
    expect(await grok('get_inbox')).not.toContain(task.code);
    expect((await s.store.task(task.id))!.status).toBe('proposed');

    // A bare "Y" and a wrong code don't approve.
    s.say(HANDLES.approval, 'Y');
    s.say(HANDLES.approval, 'Y ZZZZ');
    await s.poll();
    await s.hub.tick();
    expect((await s.store.task(task.id))!.status).toBe('proposed');

    await s.approve(task.code);
    expect((await s.store.task(task.id))!.status).toBe('sent');
    const inbox = await grok('get_inbox');
    expect(inbox).toContain(`[${task.code}] from Instinct (Ved decided): Pause all open-source issue triage and PR reviews for one week.`);
    expect(await grok('get_situation')).toContain('Open-source work paused for a week');
    expect(s.textsIntoAgentThreads()).toEqual([]);
  });
});

describe('scenario (c): "I need to shoot tomorrow"', () => {
  it('creates a Stanley script task, delivers it over the Telegram side channel, and captures Stan’s reply', async () => {
    s = await stack(STANLEY_ENV);
    await s.hub.tick(); // first Telegram poll: the side-channel thread is still empty
    const claude = await s.mcp('claude-token');

    s.worker.next.push((user) => {
      expect(user).toContain('I need to shoot tomorrow');
      return {
        summary: 'Ved needs to shoot a video tomorrow and wants a script from Stanley.',
        topics: ['content', 'shoots'],
        situation: [{ text: 'Shooting a video tomorrow', slot: 'plan:shoot', topics: ['shoots'], expires_at: inDays(2), evidence: ['m1'] }],
        tasks: [{ target_agent: 'stanley', payload: 'Write a 60-second video script for tomorrow’s shoot about launching Agent Hub.', topics: ['content', 'shoots'], evidence: ['m1'] }],
      };
    });
    await claude('log_session', { summary: 'I need to shoot tomorrow. Ved asked for a script.', transcript_excerpt: 'Ved: I need to shoot tomorrow, can Stanley write me a script?' });
    await s.hub.tick();
    await s.hub.idle();

    const [task] = await s.store.tasksByStatus(['proposed']);
    // An MCP session is the agent's own report, so the task is agent-suggested however the model cites it.
    expect([task.origin_agent, task.target_agent, task.author]).toEqual(['claude', 'stanley', 'agent']);
    expect(s.telegram.chat).toEqual([]); // not before approval
    await s.poll();
    await s.approve(task.code);

    expect((await s.store.task(task.id))!.status).toBe('sent');
    expect(s.telegram.chat).toHaveLength(1);
    expect(s.telegram.chat[0].text).toContain('Write a 60-second video script for tomorrow’s shoot about launching Agent Hub.');
    // Delivered over Telegram, never into Ved's own iMessage thread with Stan.
    expect(s.textsIntoAgentThreads()).toEqual([]);

    // Stan answers in the side channel; the reply becomes a hop-1 event tied to the task.
    s.telegram.reply('Here is your 60s script: HOOK — “I gave my AI agents a group chat.”');
    s.worker.next.push(() => ({ summary: 'Stanley delivered the 60-second script.', topics: ['content'] }));
    await s.hub.tick();
    await s.settle();
    const events = await s.store.recentEvents(5);
    const reply = events.find((e) => e.agent === 'stanley');
    expect(reply, 'Stan’s reply was captured').toBeTruthy();
    expect([reply!.hop, reply!.caused_by_task_id, reply!.author]).toEqual([1, task.id, 'agent']);
    expect(reply!.raw_excerpt).toContain('Stanley: Here is your 60s script');
    expect(reply!.raw_excerpt).not.toContain('Write a 60-second video script'); // the hub's own message isn't re-ingested as conversation
  });
});

describe('scenario (d): cross-agent context', () => {
  it('a study session logged from Gemini shows up in Claude’s get_situation, and not Boardy’s', async () => {
    s = await stack({ HUB_AGENT_TOKENS: 'claude:claude-token,gemini:gemini-token,boardy:boardy-token' });
    const gemini = await s.mcp('gemini-token');
    const claude = await s.mcp('claude-token');
    const boardy = await s.mcp('boardy-token');

    // Gemini saves it itself, as it chats: no worker run needed.
    await gemini('set_situation', { text: 'Studying for the linear algebra midterm (Friday)', topics: ['school'], slot: 'school:midterm', expires_at: inDays(3) });
    await gemini('log_session', { summary: 'Ved studied eigenvalues with Gemini for the linear algebra midterm on Friday.', topics: ['school'] });
    await s.hub.tick();
    await s.hub.idle();
    expect(s.worker.calls).toHaveLength(0);

    const view = await claude('get_situation');
    expect(view).toContain('Studying for the linear algebra midterm (Friday) (via Gemini, agent-reported');
    expect(view).toContain('Gemini: Ved studied eigenvalues with Gemini');
    const boardyView = await boardy('get_situation');
    expect(boardyView).not.toMatch(/midterm|eigenvalues|linear algebra/i);
    // Gemini doesn't see its own session echoed back as "activity in other agents".
    expect(await gemini('get_situation')).not.toContain('Gemini: Ved studied');
  });
});
