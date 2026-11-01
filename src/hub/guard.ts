import { canSee, deniedTopics, type Scope } from './scopes.js';

/**
 * Deterministic last line of defence, applied when a task is proposed AND again at delivery time.
 * Topic tags come from the LLM and can be wrong (or manipulated by prompt injection), so restricted
 * agents also get a keyword scan for the sensitive categories they must never receive.
 */
const SENSITIVE_PATTERNS: Record<'school' | 'health' | 'finances' | 'personal', RegExp> = {
  // Ambiguous words ("class", "course", "debt", "relationship") only count in personal phrasing, so
  // "world-class", "of course", "venture debt" and "customer relationships" don't trip the guard.
  school:
    /\b(school|schoolwork|(my|next|morning|evening|today'?s|tomorrow'?s) class(es)?|class schedule|lectures?|midterms?|final exams?|exams?|quiz(zes)?|homework|problem sets?|professors?|syllabus|semesters?|coursework|course ?load|my courses?|gpa|my grades|report card|tuition|campus|dorm|office hours|study(ing)? (for|session)|studied|linear algebra|calculus|organic chem(istry)?)\b/i,
  health:
    /\b(doctor|dentist|therap(y|ist)|surgery|surgeon|diagnos(is|ed)|medications?|meds|prescriptions?|symptoms?|injur(y|ies|ed)|hospital|clinic|adhd|anxiety|depression|illness|sick|mental health|blood (test|work)|physio(therapy)?|psychiatrist|allerg(y|ies)|knee|migraine)\b/i,
  finances:
    /\b(bank account|account number|routing number|salary|paycheck|pay ?check|my debt|personal debt|student loans?|personal loan|credit card|credit score|my rent|pay(ing)? rent|mortgage|my savings|savings account|net worth|tax return|my taxes|ssn|social security|venmo|overdraft)\b/i,
  personal:
    /\b(girlfriend|boyfriend|wife|husband|fianc[ée]e?|mom|dad|mother|father|parents|sister|brother|family(?! office)|dating|break ?up|my relationship|romantic|crush|divorce|funeral|religion|home address)\b/i,
};

export type SensitiveTopic = keyof typeof SENSITIVE_PATTERNS;

/** Undo cheap obfuscation before scanning: compatibility forms, accents, invisible characters, s-p-a-c-e-d letters. */
export function normalizeForScan(text: string): string {
  return text
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[\u00ad\u034f\u061c\u115f\u1160\u17b4\u17b5\u180e\u200b-\u200f\u202a-\u202e\u2060-\u206f\ufeff]/g, '')
    .replace(/\b(?:\p{L}[._*-]){2,}\p{L}\b/gu, (m) => m.replace(/[._*-]/g, ''))
    .replace(/\b(?:\p{L} ){2,}\p{L}\b/gu, (m) => m.replace(/ /g, ''));
}

export function sensitiveTopicsIn(text: string): SensitiveTopic[] {
  const variants = [text, normalizeForScan(text)];
  return (Object.keys(SENSITIVE_PATTERNS) as SensitiveTopic[]).filter((t) => variants.some((v) => SENSITIVE_PATTERNS[t].test(v)));
}

export interface GuardResult {
  ok: boolean;
  reason: string | null;
  /** Context lines that survived filtering. */
  context: string[];
}

/** Can `payload` (+ context) be handed to an agent with `scope`? */
export function checkDelivery(scope: Scope | undefined, agentName: string, task: { payload: string; topics: string[] }, context: string[] = []): GuardResult {
  if (!scope || !scope.enabled) return { ok: false, reason: `${agentName} is disabled`, context: [] };
  if (!canSee(scope, task.topics)) {
    return { ok: false, reason: `outside ${agentName}'s scope (topics: ${task.topics.join(', ') || 'general'})`, context: [] };
  }
  const denied = deniedTopics(scope);
  const leaked = sensitiveTopicsIn(task.payload).filter((t) => denied.has(t));
  if (leaked.length) {
    return { ok: false, reason: `payload mentions ${leaked.join(', ')}, which ${agentName} may never receive`, context: [] };
  }
  const safeContext = context.filter((line) => !sensitiveTopicsIn(line).some((t) => denied.has(t)));
  return { ok: true, reason: null, context: safeContext };
}
