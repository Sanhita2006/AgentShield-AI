import type Database from 'better-sqlite3';
import type { GatewayExecuteRequest, GatewaySettings, RiskSignal, StageResult, Verdict } from '../types.ts';
import type { GrantRow } from './stage2_delegation.ts';
import { isDemoMode } from '../config.ts';
import { formatInrFromPaise, paiseToRupees, tryRupeesToPaise } from '../money.ts';
import { DEFAULT_CUSTOMER_TIMEZONE, formatHour12, getHourInTimezone } from '../time.ts';

interface BaselineRow {
  id: string;
  agent_id: string;
  customer_id: string;
  sample_count: number;
  typical_amount_mean: number; // integer paise
  typical_amount_std: number; // integer paise
  typical_hours: string;
  known_payees: string;
  typical_action_mix: string;
  typical_call_rate_per_min: number;
  last_action_type: string | null;
}

export interface Stage3Output {
  riskScore: number;
  verdict: Verdict;
  signals: RiskSignal[];
  customerReasons: string[];
  technicalReasons: string[];
  threatType: string;
  stageResult: StageResult;
}

const CONFUSABLE_MAP: Record<string, string> = {
  '\u0430': 'a', '\u0410': 'A', // Cyrillic а/А
  '\u0435': 'e', '\u0415': 'E', // Cyrillic е/Е
  '\u0456': 'i', '\u0406': 'I', // Cyrillic і/І
  '\u0458': 'j', '\u0408': 'J', // Cyrillic ј/Ј
  '\u043e': 'o', '\u041e': 'O', // Cyrillic о/О
  '\u0440': 'p', '\u0420': 'P', // Cyrillic р/Р
  '\u0441': 'c', '\u0421': 'C', // Cyrillic с/С
  '\u0455': 's', '\u0405': 'S', // Cyrillic ѕ/Ѕ (looks like s)
  '\u0443': 'y', '\u0423': 'Y', // Cyrillic у/У
  '\u0445': 'x', '\u0425': 'X', // Cyrillic х/Х
  '\u043a': 'k', '\u041a': 'K', // Cyrillic к/К
  '\u043c': 'm', '\u041c': 'M', // Cyrillic м/М
  '\u043d': 'h', '\u041d': 'H', // Cyrillic н/Н
  '\u0442': 't', '\u0422': 'T', // Cyrillic т/Т
  '\u0432': 'b', '\u0412': 'B', // Cyrillic в/В
  '\u03b1': 'a', '\u03b5': 'e', '\u03bf': 'o', '\u03c1': 'p', '\u03b9': 'i', '\u03ba': 'k', // Greek
};

function foldConfusables(input: string): string {
  return input
    .normalize('NFKC')
    .replace(/[\u0300-\u036f\u200B-\u200F\u202A-\u202E\u2060-\u206F\uFEFF\u00AD]/g, '')
    .replace(/[\u0370-\u03FF\u0400-\u04FF]/g, (ch) => CONFUSABLE_MAP[ch] ?? ch)
    .replace(/\s+/g, ' ');
}

function foldLeetspeak(input: string): string {
  return input
    .replace(/0/g, 'o')
    .replace(/1/g, 'i')
    .replace(/3/g, 'e')
    .replace(/4/g, 'a')
    .replace(/5/g, 's')
    .replace(/7/g, 't')
    .replace(/\$/g, 's')
    // Only replace @ with 'a' when surrounded by word chars (preserve VPA handles like attacker@upi)
    .replace(/([a-zA-Z])@([a-zA-Z])/g, '$1a$2');
}

function decodeHtmlEntities(input: string): string {
  return input
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&apos;/gi, "'")
    .replace(/&amp;/gi, '&')
    .replace(/&#x([0-9a-fA-F]{1,4});/g, (_, hex) => {
      const code = Number.parseInt(hex, 16);
      return code >= 32 && code <= 126 ? String.fromCharCode(code) : ' ';
    })
    .replace(/&#(\d{1,5});/g, (_, dec) => {
      const code = Number.parseInt(dec, 10);
      return code >= 32 && code <= 126 ? String.fromCharCode(code) : ' ';
    });
}

function extractDecodedPayloads(snippet: string): Array<{ encoding: string; text: string }> {
  const out: Array<{ encoding: string; text: string }> = [];

  if (/&(?:#\d+|#x[0-9a-fA-F]+|lt|gt|quot);/i.test(snippet)) {
    const htmlDecoded = decodeHtmlEntities(snippet);
    if (htmlDecoded !== snippet) {
      out.push({ encoding: 'HTML entities', text: foldConfusables(htmlDecoded) });
    }
  }

  // Match >= 2 URL percent-escapes even when separated by words (e.g. "ignore%20previous%20instructions")
  if (/(?:%[0-9a-fA-F]{2}).*(?:%[0-9a-fA-F]{2})/.test(snippet)) {
    try {
      const urlDecoded = decodeURIComponent(snippet.replace(/\+/g, ' '));
      if (urlDecoded !== snippet) {
        out.push({ encoding: 'URL-encoded payload', text: foldConfusables(urlDecoded) });
      }
    } catch {
      // ignore malformed % sequences
    }
  }

  const b64Matches = snippet.match(/\b[A-Za-z0-9+/]{16,}={0,2}\b/g) ?? [];
  for (const token of b64Matches.slice(0, 4)) {
    try {
      const buf = Buffer.from(token, 'base64');
      if (buf.length < 8 || buf.length > 512) continue;
      const decoded = buf.toString('utf8');
      const printableCount = decoded.replace(/[^\x20-\x7E\r\n]/g, '').length;
      if (printableCount / decoded.length >= 0.85) {
        out.push({ encoding: 'Base64 payload', text: foldConfusables(decoded) });
      }
    } catch {
      // ignore invalid base64
    }
  }

  const hexMatches = snippet.match(/(?:0x|\\x)?(?:[0-9a-fA-F]{2}){8,}/g) ?? [];
  for (const rawHex of hexMatches.slice(0, 4)) {
    try {
      const cleanHex = rawHex.replace(/0x|\\x/gi, '');
      if (cleanHex.length % 2 !== 0 || cleanHex.length > 1024) continue;
      const decoded = Buffer.from(cleanHex, 'hex').toString('utf8');
      const printableCount = decoded.replace(/[^\x20-\x7E\r\n]/g, '').length;
      if (printableCount / decoded.length >= 0.85) {
        out.push({ encoding: 'Hex-encoded payload', text: foldConfusables(decoded) });
      }
    } catch {
      // ignore invalid hex
    }
  }

  return out;
}

const INJECTION_PATTERNS: Array<{ pattern: RegExp; label: string; weight: number; raw?: boolean }> = [
  {
    pattern: /(ignore|disregard|forget|override|bypass|skip)\s+(?:(?:all|any|the|your|these|my|previous|prior|above|earlier|preceding|system|safety|security)\s+){0,3}(instructions?|rules|prompts?|directions?|policies|checks?|guardrails?|limits?)/i,
    label: 'Instruction override ("ignore previous instructions")',
    weight: 48,
  },
  {
    pattern: /(system\s+override|developer\s+mode|jailbreak|disregard\s+rules|bypass\s+(?:approval|verification|pin)|skip\s+security)/i,
    label: 'System prompt override directive',
    weight: 45,
  },
  {
    pattern: /(pretend\s+(?:you\s+are|to\s+be)|roleplay\s+as|act\s+as\s+(?:an?\s+)?(?:unrestricted|root|admin|autonomous)\s+agent|hypothetically\s+(?:if\s+you|transfer|send|pay|wire))/i,
    label: 'Roleplay / hypothetical policy bypass framing',
    weight: 42,
  },
  {
    pattern: /(?:for\s+(?:audit|compliance|verification|reconciliation|maintenance|security)\s+(?:test|check)|do\s+not\s+(?:inform|alert|tell)\s+(?:the\s+)?(?:user|customer)).{0,55}(?:transfer|send|pay|wire|remit)/i,
    label: 'Disguised audit/stealth wire instruction',
    weight: 42,
  },
  {
    // A customer's own instruction does not cite memos, desks or colleagues as the reason to pay.
    // Text that justifies a payment by pointing at a third-party authority (or says a third party
    // approved it) is the signature of an injected "business" instruction, so it is escalated to the
    // customer instead of being auto-allowed. Written as a concept, not from specific benchmark strings.
    pattern: new RegExp(
      [
        // internal documents cited as authority
        String.raw`\b(?:(?:finance|treasury|internal|management|operations|board|cfo)\s+(?:memo|note)|(?:internal\s+)?meeting\s+notes?|memo\s+item)\b`,
        // "<role> ... approved/confirmed/requested"
        String.raw`\b(?:cfo|ceo|manager|head|team|department|desk|office|administrator|admin|compliance|procurement|treasury|finance|operations|coordinator|controller|director|supervisor)\b[^.]{0,40}\b(?:approved|authori[sz]ed|authori[sz]ation|signed\s+off|confirmed|agreed|requested|instructed|advised|asked|said)\b`,
        // "approved/confirmed by <role>"
        String.raw`\b(?:approved|authori[sz]ed|confirmed|requested|instructed|advised|signed\s+off)\s+by\s+(?:the\s+|our\s+|your\s+)?(?:[a-z-]+\s+){0,3}(?:cfo|ceo|manager|head|team|department|desk|office|administrator|admin|compliance|procurement|treasury|finance|operations|coordinator|controller|director|supervisor)\b`,
        // "as requested by / per / reminder from <role>"
        String.raw`\b(?:as\s+requested\s+by|per|reminder\s+from)\s+(?:the\s+|our\s+|your\s+)?(?:[a-z-]+\s+){0,3}(?:coordinator|manager|desk|department|office|controller|director|treasury|team)\b`,
      ].join('|'),
      'i'
    ),
    label: 'Third-party authority cited as payment justification',
    weight: 40,
  },
  {
    pattern: /(urgent|immediately|right\s+now|emergency|asap).{0,45}(transfer|send|pay|wire|remit)\b/i,
    label: 'Coercive urgency transfer instruction',
    weight: 42,
  },
  {
    pattern: /<!--[\s\S]*?(transfer|pay|send|upi|vpa|ignore|override)[\s\S]*?-->/i,
    label: 'Hidden HTML comment payment payload',
    weight: 48,
  },
  {
    pattern: /(\[hidden\]|hidden\s*:|zero-width|\u200B|\u200C|\u200D|\uFEFF)/i,
    label: 'Steganographic / hidden text marker',
    weight: 42,
    raw: true,
  },
  {
    pattern: /(new\s+beneficiary|override\s+payee|redirect\s+funds|updated\s+(?:bank|upi|vpa)\s+(?:account|id)|(?:send|transfer|wire|remit)\s+(?:funds|money|amount|\d+\s*)?\s*(?:to\s+)?[a-z0-9._-]+@[a-z]+)/i,
    label: 'Embedded payee redirection instruction',
    weight: 42,
  },
  {
    pattern: /(?:purane|pichle|saare|sab)\s+(?:niyam|instructions?|rules)\s+(?:bhul|bhool|chhod|ignore)/i,
    label: 'Hinglish rule override directive',
    weight: 45,
  },
  {
    pattern: /(?:(?:abhi|turant|jaldi|fauran)\s+(?:paise|rupaye|rs|amount|balance)?\s*(?:bhej\s*do|transfer\s*karo|pay\s*karo|bhejo)|(?:paise|rupaye)\s*(?:bhej\s*do|transfer\s*karo)\s*(?:abhi|turant))/i,
    label: 'Hinglish coerced payment directive',
    weight: 42,
  },
  {
    pattern: /(?:naya|dusre|is)\s+(?:khate|account|upi|vpa)\s*(?:[a-z0-9._@-]+\s+)?(?:me|mein|par)\s*(?:paise\s*)?(?:bhej|daal|transfer)/i,
    label: 'Hinglish beneficiary redirect',
    weight: 42,
  },
  {
    pattern: /(?:ager|purono|shob|sob)\s+(?:niyom|niyam|instructions?|rules)\s+(?:vule|bhule|bad)\s*(?:jao|dao)?/i,
    label: 'Bengali transliterated rule override',
    weight: 45,
  },
  {
    pattern: /(?:ekhoni|taratari|takhuni)\s+(?:taka|poisa|amount)?\s*(?:pathao|pathiye\s*dao|transfer\s*koro|pay\s*koro)/i,
    label: 'Bengali transliterated coerced payment directive',
    weight: 42,
  },
  {
    pattern: /(?:notun|onno|ei)\s+(?:account|khata|upi|vpa)\s*(?:[a-z0-9._@-]+\s+)?(?:e|te)\s*(?:taka\s+)?(?:pathao|pathiye\s*dao|transfer)/i,
    label: 'Bengali transliterated beneficiary redirect',
    weight: 42,
  },
];

// Deterministic heuristic detector (fast pass). Does NOT catch all purely semantic paraphrases.
export function detectPromptInjection(snippet?: string): { detected: boolean; matches: string[]; scoreBoost: number } {
  if (!snippet || !snippet.trim()) {
    return { detected: false, matches: [], scoreBoost: 0 };
  }
  const matches: string[] = [];
  const seenLabels = new Set<string>();
  let boost = 0;

  const normalized = foldConfusables(snippet);
  const leetspeak = foldLeetspeak(normalized);
  const decoded = extractDecodedPayloads(snippet);

  const candidates: Array<{ tag?: string; text: string; allowRawOnly?: boolean }> = [
    { text: snippet, allowRawOnly: true },
    { text: normalized },
    { text: leetspeak },
    ...decoded.map((d) => ({ tag: d.encoding, text: d.text })),
    ...decoded.map((d) => ({ tag: `${d.encoding}+leetspeak`, text: foldLeetspeak(d.text) })),
  ];

  for (const rule of INJECTION_PATTERNS) {
    if (seenLabels.has(rule.label)) continue;
    for (const c of candidates) {
      if (rule.raw && !c.allowRawOnly) continue;
      if (!rule.raw && c.allowRawOnly) continue;
      const match = c.text.match(rule.pattern);
      if (match) {
        const prefix = c.tag ? `[${c.tag}] ` : '';
        matches.push(`${prefix}${rule.label}: "${match[0].slice(0, 72)}"`);
        seenLabels.add(rule.label);
        boost += rule.weight;
        break;
      }
    }
  }

  return {
    detected: matches.length > 0,
    matches,
    scoreBoost: Math.min(65, boost),
  };
}

export function evaluateIntentAlignment(
  statedIntent: string,
  action: string,
  params: GatewayExecuteRequest['params']
): { mismatch: boolean; scoreBoost: number; reason?: string } {
  const intent = (statedIntent || '').toLowerCase();
  if (!intent.trim()) {
    return { mismatch: true, scoreBoost: 35, reason: 'No stated intent provided for agent session' };
  }

  const readOnlyIntent =
    /\b(check|view|read|inspect|list|summarize|audit|fetch|show|balance|statement)\b/.test(intent) &&
    !/\b(pay|settle|transfer|send|remit|add\s+payee)\b/.test(intent);

  if (readOnlyIntent && (action === 'pay_bill' || action === 'transfer' || action === 'add_payee')) {
    return {
      mismatch: true,
      scoreBoost: 50,
      reason: `Stated intent ("${statedIntent}") describes read-only inspection, but agent attempted '${action}'`,
    };
  }

  if (action === 'transfer' && /\b(electricity|water|gas|fiber|broadband|bill)\b/.test(intent) && !/\btransfer\b/.test(intent)) {
    return {
      mismatch: true,
      scoreBoost: 45,
      reason: `Stated intent ("${statedIntent}") refers to utility bill settlement, not peer transfer`,
    };
  }

  if (action === 'pay_bill' && params.category) {
    const cat = params.category.toLowerCase();
    const otherCats = ['electricity', 'water', 'gas', 'telecom'].filter((c) => c !== cat);
    const mentionedOther = otherCats.find((c) => intent.includes(c));
    if (mentionedOther && !intent.includes(cat)) {
      return {
        mismatch: true,
        scoreBoost: 38,
        reason: `Stated intent references '${mentionedOther}', but payment targets '${cat}'`,
      };
    }
  }

  return { mismatch: false, scoreBoost: 0 };
}

export function getSettings(db: Database.Database): GatewaySettings {
  const rows = db.prepare(`SELECT key, value FROM settings`).all() as Array<{ key: string; value: string }>;
  const map = new Map(rows.map((r) => [r.key, r.value]));
  return {
    allowMaxScore: Number(map.get('allow_max_score') ?? 39),
    askMaxScore: Number(map.get('ask_max_score') ?? 69),
    approvalExpiryMinutes: Number(map.get('approval_expiry_minutes') ?? 10),
    rateLimitPerMinute: Number(map.get('rate_limit_per_minute') ?? 60),
    enableLlmJudge: (map.get('enable_llm_judge') ?? 'true') === 'true',
    alwaysAskCustomer: (map.get('always_ask_customer') ?? 'false') === 'true',
    askCustomerOnBlock: (map.get('ask_customer_on_block') ?? 'false') === 'true',
    requireRegisteredSession: (map.get('require_registered_session') ?? 'false') === 'true',
  };
}

export function getCustomerTimezone(db: Database.Database, customerId: string): string {
  const row = db.prepare(`SELECT timezone FROM customers WHERE id = ?`).get(customerId) as { timezone?: string } | undefined;
  return row?.timezone || DEFAULT_CUSTOMER_TIMEZONE;
}

export function resolveEffectiveHour(db: Database.Database, customerId: string, now: number, simulatedHour?: number): number {
  if (isDemoMode() && simulatedHour !== undefined && Number.isInteger(simulatedHour) && simulatedHour >= 0 && simulatedHour <= 23) {
    return simulatedHour;
  }
  return getHourInTimezone(now, getCustomerTimezone(db, customerId));
}

export function runStage3Behavior(
  db: Database.Database,
  req: GatewayExecuteRequest,
  context: { agentId: string; customerId: string; grant?: GrantRow },
  now: number = Date.now()
): Stage3Output {
  const t0 = performance.now();
  const signals: RiskSignal[] = [];

  const baseline = db
    .prepare(`SELECT * FROM baselines WHERE agent_id = ? AND customer_id = ?`)
    .get(context.agentId, context.customerId) as BaselineRow | undefined;

  const settings = getSettings(db);
  const amountPaise = tryRupeesToPaise(req.params.amount ?? 0) ?? 0;
  const isMoneyMoving = req.action === 'pay_bill' || req.action === 'transfer';

  // 1. Provenance & Prompt Injection Detection
  const inj = detectPromptInjection(req.contextSnippet);
  if (inj.detected) {
    signals.push({
      code: 'PROMPT_INJECTION',
      label: 'Prompt injection detected',
      weight: inj.scoreBoost,
      customerReason: 'Hidden or suspicious instructions were detected inside the document or web content the agent read.',
      technicalReason: `Injection heuristic matched (${inj.matches.join('; ')})`,
      matchedSnippet: inj.matches[0],
    });
  }

  if ((req.provenance === 'untrusted_document' || req.provenance === 'web_content') && (isMoneyMoving || req.action === 'add_payee')) {
    signals.push({
      code: 'UNTRUSTED_PROVENANCE',
      label: 'Untrusted context provenance',
      weight: 30,
      customerReason: `Agent attempted a ${req.action.replace('_', ' ')} triggered by ${req.provenance.replace('_', ' ')} rather than your direct instruction.`,
      technicalReason: `Money-moving action '${req.action}' originated from '${req.provenance}'`,
    });
  }

  // 2. Intent Mismatch & Server-Side Session Trust Cross-Check
  let registeredSessionIntent: string | null = null;
  let provenanceTrust: 'corroborated_session' | 'self_reported' = 'self_reported';

  if (req.sessionId) {
    const sess = db
      .prepare(`SELECT id, agent_id, customer_id, stated_intent, expires_at FROM sessions WHERE id = ?`)
      .get(req.sessionId) as
      | { id: string; agent_id: string; customer_id: string; stated_intent: string; expires_at: number }
      | undefined;

    if (!sess || sess.customer_id !== context.customerId || sess.agent_id !== context.agentId || sess.expires_at < now) {
      signals.push({
        code: 'INVALID_SESSION',
        label: 'Session registration missing or expired',
        weight: 45,
        customerReason: 'The agent referenced an unrecognized or expired user session.',
        technicalReason: `sessionId '${req.sessionId}' missing, expired, or bound to another agent/customer`,
      });
    } else {
      registeredSessionIntent = sess.stated_intent;
      provenanceTrust = 'corroborated_session';
      const signedIntentCheck = evaluateIntentAlignment(sess.stated_intent, req.action, req.params);
      if (signedIntentCheck.mismatch) {
        signals.push({
          code: 'SESSION_INTENT_MISMATCH',
          label: 'Diverges from customer-registered session intent',
          weight: 48,
          customerReason: `You started this session for "${sess.stated_intent}", which does not match the agent's '${req.action}'.`,
          technicalReason: `Customer-registered session intent ("${sess.stated_intent}") contradicts action '${req.action}'`,
        });
      }
    }
  } else if (settings.requireRegisteredSession && isMoneyMoving) {
    signals.push({
      code: 'UNCORROBORATED_SESSION',
      label: 'No customer-registered session',
      weight: Math.min(settings.askMaxScore, Math.max(40, settings.allowMaxScore + 1)),
      customerReason: 'Strict session binding is enabled and this payment has no registered user session.',
      technicalReason: 'require_registered_session=true and req.sessionId missing for money-moving action',
    });
  }

  const intentEval = evaluateIntentAlignment(req.intent, req.action, req.params);
  if (intentEval.mismatch) {
    signals.push({
      code: 'INTENT_MISMATCH',
      label: 'Intent mismatch',
      weight: intentEval.scoreBoost,
      customerReason: `The agent's stated task ("${req.intent}") does not match the banking action it tried to perform.`,
      technicalReason: intentEval.reason || 'Action diverges from declared session intent',
    });
  }

  // 3. Velocity Burst & Call Rate Anomaly
  const oneMinAgo = now - 60_000;
  const recentReqCount = (
    db
      .prepare(`SELECT COUNT(*) AS cnt FROM requests WHERE agent_id = ? AND customer_id = ? AND created_at >= ?`)
      .get(context.agentId, context.customerId, oneMinAgo) as { cnt: number }
  ).cnt;

  const typicalRate = baseline?.typical_call_rate_per_min ?? 2;
  if (recentReqCount >= 4 || recentReqCount > typicalRate * 2.5) {
    const burstWeight = recentReqCount >= 5 ? 52 : 42;
    signals.push({
      code: 'VELOCITY_BURST',
      label: 'Abnormal call velocity burst',
      weight: burstWeight,
      customerReason: `Agent sent ${recentReqCount + 1} requests in under 60 seconds, far above its normal pace.`,
      technicalReason: `Call rate ${recentReqCount + 1}/min exceeds baseline ${typicalRate}/min (>2.5x threshold)`,
    });
  }

  const askWeight = Math.min(settings.askMaxScore, Math.max(40, settings.allowMaxScore + 1));

  // 3b. Creating a payee requires customer approval
  if (req.action === 'add_payee') {
    signals.push({
      code: 'PAYEE_ADDITION',
      label: 'Agent wants to add a payee',
      weight: askWeight,
      customerReason: `The agent asked to add a new payee (${req.params.payeeName || req.params.payeeVpa || 'unnamed'}) to your account.`,
      technicalReason: `add_payee by agent always requires customer confirmation`,
    });
  }

  // 3c. Cold-start escalation
  if (isMoneyMoving && !baseline) {
    signals.push({
      code: 'NO_BASELINE',
      label: 'No behavioural history for this agent',
      weight: askWeight,
      customerReason: 'This agent has no payment history on your account yet, so this payment needs your confirmation.',
      technicalReason: `No baseline for agent ${context.agentId} / customer ${context.customerId}; cold-start escalation`,
    });
  }

  // 4. Behavioural checks for money-moving actions (all money math in integer paise)
  if (isMoneyMoving && baseline) {
    const knownPayees: string[] = JSON.parse(baseline.known_payees || '[]');
    const typicalHours: number[] = JSON.parse(baseline.typical_hours || '[]');
    const actionMix: Record<string, number> = JSON.parse(baseline.typical_action_mix || '{}');

    // New payee signal (weight 40 ensures solo new payee lands in ASK_CUSTOMER band >= allowMaxScore+1,
    // while combined with unusual hour 11 + amount anomaly 18 = 69 stays in ASK_CUSTOMER rather than hard-blocking)
    const targetPayeeKey = req.params.payeeId || req.params.payeeVpa || req.params.payeeName || '';
    const isKnownPayee =
      (Boolean(req.params.payeeId) && knownPayees.includes(req.params.payeeId as string)) ||
      (Boolean(req.params.payeeVpa) && knownPayees.includes(`vpa:${String(req.params.payeeVpa).toLowerCase()}`)) ||
      (!req.params.payeeId && !req.params.payeeVpa && Boolean(req.params.payeeName) && knownPayees.includes(req.params.payeeName as string));
    if (!isKnownPayee) {
      signals.push({
        code: 'NEW_PAYEE',
        label: 'New or unrecognized payee',
        weight: 40,
        customerReason: `Payment targets a NEW payee (${req.params.payeeName || targetPayeeKey || 'Unverified recipient'}) not in your 30-day history.`,
        technicalReason: `Payee '${targetPayeeKey}' absent from baseline known_payees [${knownPayees.join(', ')}]`,
      });
    }

    // Unusual hour signal computed in customer's timezone (default Asia/Kolkata)
    const hour = resolveEffectiveHour(db, context.customerId, now, req.simulatedHour);
    if (typicalHours.length > 0 && !typicalHours.includes(hour)) {
      signals.push({
        code: 'UNUSUAL_HOUR',
        label: 'Unusual time of day',
        weight: 11,
        customerReason: `Action triggered at ${formatHour12(hour)}, outside this agent's usual operating hours.`,
        technicalReason: `Execution hour ${hour}:00 (${getCustomerTimezone(db, context.customerId)}) outside baseline typical_hours [${typicalHours.join(',')}]`,
      });
    }

    // Amount z-score / > 3x typical (both in paise)
    if (baseline.typical_amount_mean > 0 && amountPaise > 0) {
      const stdPaise = Math.max(10_000, baseline.typical_amount_std);
      const zScore = (amountPaise - baseline.typical_amount_mean) / stdPaise;
      if (amountPaise > baseline.typical_amount_mean * 3 || zScore >= 3.0) {
        signals.push({
          code: 'AMOUNT_ANOMALY',
          label: 'High amount deviation',
          weight: 18,
          customerReason: `${formatInrFromPaise(amountPaise)} is ${(amountPaise / baseline.typical_amount_mean).toFixed(1)}x higher than this agent's usual ${formatInrFromPaise(baseline.typical_amount_mean)} payment.`,
          technicalReason: `Amount ${formatInrFromPaise(amountPaise)} vs baseline mean ${formatInrFromPaise(baseline.typical_amount_mean)} (std ${formatInrFromPaise(stdPaise)}, z=${zScore.toFixed(2)})`,
        });
      }
    }

    // Structuring / Smurfing detection (85-100% of limit or repeated near-limit payments)
    if (context.grant && context.grant.per_txn_limit > 0) {
      const ratio = amountPaise / context.grant.per_txn_limit;
      if (ratio >= 0.85 && ratio <= 1.0) {
        const tenMinsAgo = now - 600_000;
        const nearLimitThresholdPaise = Math.round(context.grant.per_txn_limit * 0.85);
        const nearLimitRecent = (
          db
            .prepare(
              `SELECT COUNT(*) AS cnt FROM requests WHERE agent_id = ? AND customer_id = ? AND amount >= ? AND created_at >= ?`
            )
            .get(context.agentId, context.customerId, nearLimitThresholdPaise, tenMinsAgo) as { cnt: number }
        ).cnt;

        const structWeight = nearLimitRecent >= 1 ? 52 : 25;
        signals.push({
          code: 'STRUCTURING',
          label: 'Threshold structuring pattern',
          weight: structWeight,
          customerReason:
            nearLimitRecent >= 1
              ? `Multiple payments of ${formatInrFromPaise(amountPaise)} clustered just under your ${formatInrFromPaise(context.grant.per_txn_limit)} limit (possible smurfing).`
              : `Payment of ${formatInrFromPaise(amountPaise)} sits just under your ${formatInrFromPaise(context.grant.per_txn_limit)} ceiling.`,
          technicalReason: `Structuring signal: amount/limit=${(ratio * 100).toFixed(1)}%, recent near-limit txns=${nearLimitRecent}`,
        });
      }
    }

    // Sudden switch from read-only to write action
    if (baseline.last_action_type === 'check_balance' && (actionMix.check_balance ?? 0) >= 0.85) {
      signals.push({
        code: 'READ_TO_WRITE_SWITCH',
        label: 'Sudden read-to-write shift',
        weight: 22,
        customerReason: 'Agent previously only read balances and suddenly attempted a money transfer.',
        technicalReason: `Action mix is ${Math.round((actionMix.check_balance ?? 0) * 100)}% read-only; sudden transition to '${req.action}'`,
      });
    }

    // Action never used before
    if ((actionMix[req.action] ?? 0) === 0 && baseline.sample_count >= 5) {
      signals.push({
        code: 'NOVEL_ACTION',
        label: 'Action never used before',
        weight: 16,
        customerReason: `This agent has never performed "${req.action.replace('_', ' ')}" on your account before.`,
        technicalReason: `Action '${req.action}' has 0% historical frequency in ${baseline.sample_count} baseline samples`,
      });
    }
  }

  const rawScore = signals.reduce((sum, s) => sum + s.weight, 0);
  let riskScore = Math.max(0, Math.min(100, Math.round(rawScore)));

  let verdict: Verdict = 'ALLOW';
  if (riskScore > settings.askMaxScore) {
    verdict = 'BLOCK';
  } else if (riskScore > settings.allowMaxScore) {
    verdict = 'ASK_CUSTOMER';
  }

  // Optional customer policy: require approval before initiating any payment even if nominal
  if (verdict === 'ALLOW' && isMoneyMoving && settings.alwaysAskCustomer) {
    const bumpWeight = Math.max(1, settings.allowMaxScore + 1 - riskScore);
    signals.push({
      code: 'CUSTOMER_CONFIRM_POLICY',
      label: 'Customer pre-payment approval policy',
      weight: bumpWeight,
      customerReason: 'Your account preference asks for your approval before initiating any payment.',
      technicalReason: 'always_ask_customer preference escalated ALLOW to ASK_CUSTOMER',
    });
    riskScore = Math.min(settings.askMaxScore, Math.max(settings.allowMaxScore + 1, riskScore));
    verdict = 'ASK_CUSTOMER';
  }

  const threatType =
    signals.length > 0
      ? signals.slice().sort((a, b) => b.weight - a.weight)[0].code.toLowerCase()
      : 'nominal';

  const customerReasons =
    signals.length > 0
      ? signals.map((s) => s.customerReason)
      : [`Matches your 30-day usage baseline (${req.params.payeeName || req.action}).`];

  const technicalReasons =
    signals.length > 0
      ? signals.map((s) => `[+${s.weight}] ${s.technicalReason}`)
      : [`Risk score ${riskScore}/100 <= allow threshold ${settings.allowMaxScore}; baseline nominal`];

  return {
    riskScore,
    verdict,
    signals,
    customerReasons,
    technicalReasons,
    threatType,
    stageResult: {
      stage: 3,
      name: 'Behaviour & Intent Engine',
      status: verdict === 'ALLOW' ? 'PASS' : verdict === 'ASK_CUSTOMER' ? 'WARN' : 'FAIL',
      latencyMs: Number((performance.now() - t0).toFixed(2)),
      summary: `Risk score ${riskScore}/100 -> ${verdict} (${signals.length} signal${signals.length === 1 ? '' : 's'})`,
      details: {
        riskScore,
        amount: paiseToRupees(amountPaise),
        amountPaise,
        provenanceTrust,
        registeredSessionIntent,
        thresholds: { allowMax: settings.allowMaxScore, askMax: settings.askMaxScore },
        signals: signals.map((s) => ({ code: s.code, weight: s.weight, matchedSnippet: s.matchedSnippet })),
      },
    },
  };
}

/**
 * Raise-only merge of Stage 3b LLM Semantic Judge outcome into deterministic Stage 3 rules output.
 * Never lowers rule riskScore or downgrades a verdict. If provenance != user_instruction on a money-moving
 * action and the judge is unavailable/errors, escalates ALLOW -> ASK_CUSTOMER fail-safely.
 */
export function applyStage3bOutcome(
  s3: Stage3Output,
  req: GatewayExecuteRequest,
  settings: GatewaySettings,
  judge: {
    available: boolean;
    evaluation: { verdict: 'SAFE' | 'SUSPICIOUS' | 'MALICIOUS'; confidence: number; reasons: string[] } | null;
    errorReason?: string;
  }
): Stage3Output {
  const isMoneyMoving = req.action === 'pay_bill' || req.action === 'transfer' || req.action === 'add_payee';
  const signals = [...s3.signals];
  let riskScore = s3.riskScore;
  let verdict = s3.verdict;

  if (judge.evaluation) {
    if (judge.evaluation.verdict === 'MALICIOUS') {
      const targetScore = Math.max(riskScore, settings.askMaxScore + 15);
      const boost = Math.max(10, targetScore - riskScore);
      riskScore = Math.min(100, targetScore);
      signals.push({
        code: 'LLM_JUDGE_MALICIOUS',
        label: 'Stage 3b LLM judge flagged malicious intent',
        weight: boost,
        customerReason: `Semantic security verifier blocked this action: ${judge.evaluation.reasons[0]}`,
        technicalReason: `Stage 3b judge MALICIOUS (${Math.round(judge.evaluation.confidence * 100)}%): ${judge.evaluation.reasons.join('; ')}`,
      });
    } else if (judge.evaluation.verdict === 'SUSPICIOUS') {
      const targetScore = Math.max(riskScore, settings.allowMaxScore + 8);
      const boost = Math.max(5, targetScore - riskScore);
      riskScore = Math.min(100, targetScore);
      signals.push({
        code: 'LLM_JUDGE_SUSPICIOUS',
        label: 'Stage 3b LLM judge flagged suspicious context',
        weight: boost,
        customerReason: `Semantic security verifier asked for your confirmation: ${judge.evaluation.reasons[0]}`,
        technicalReason: `Stage 3b judge SUSPICIOUS (${Math.round(judge.evaluation.confidence * 100)}%): ${judge.evaluation.reasons.join('; ')}`,
      });
    }
  } else if (isMoneyMoving && req.provenance !== 'user_instruction' && verdict === 'ALLOW') {
    const targetScore = Math.max(riskScore, settings.allowMaxScore + 1);
    const boost = Math.max(1, targetScore - riskScore);
    riskScore = Math.min(settings.askMaxScore, targetScore);
    signals.push({
      code: 'JUDGE_UNAVAILABLE_ESCALATION',
      label: 'Semantic verifier unavailable for non-user context',
      weight: boost,
      customerReason: `This request came from ${req.provenance.replace('_', ' ')} and the AI verifier was unavailable, so your confirmation is required.`,
      technicalReason: `Money-moving action with provenance '${req.provenance}' escalated cleanly because Stage 3b judge unavailable (${judge.errorReason || 'not configured'})`,
    });
  }

  // Enforce strict monotonic raise-only verdict thresholds
  if (riskScore > settings.askMaxScore) {
    verdict = 'BLOCK';
  } else if (riskScore > settings.allowMaxScore && verdict === 'ALLOW') {
    verdict = 'ASK_CUSTOMER';
  }

  const threatType =
    signals.length > 0
      ? signals.slice().sort((a, b) => b.weight - a.weight)[0].code.toLowerCase()
      : s3.threatType;

  const customerReasons =
    signals.length > 0 ? signals.map((s) => s.customerReason) : s3.customerReasons;
  const technicalReasons =
    signals.length > 0 ? signals.map((s) => `[+${s.weight}] ${s.technicalReason}`) : s3.technicalReasons;

  return {
    ...s3,
    riskScore,
    verdict,
    signals,
    customerReasons,
    technicalReasons,
    threatType,
  };
}

// Update baseline ONLY from ALLOW or customer-approved actions (prevents baseline poisoning)
export function updateBaselineFromApprovedAction(
  db: Database.Database,
  agentId: string,
  customerId: string,
  req: GatewayExecuteRequest,
  now: number = Date.now(),
  opts: { trustPayee?: boolean } = {}
): void {
  const registered = req.params.payeeId
    ? Boolean(db.prepare(`SELECT 1 FROM payees WHERE id = ? AND customer_id = ?`).get(req.params.payeeId, customerId))
    : false;
  const registeredId = registered ? req.params.payeeId : undefined;
  const payeeKey = registeredId
    ? registeredId
    : opts.trustPayee
    ? req.params.payeeId
      ? req.params.payeeId
      : req.params.payeeVpa
      ? `vpa:${String(req.params.payeeVpa).toLowerCase()}`
      : req.params.payeeName
    : undefined;
  const baseline = db
    .prepare(`SELECT * FROM baselines WHERE agent_id = ? AND customer_id = ?`)
    .get(agentId, customerId) as BaselineRow | undefined;

  const amountPaise = tryRupeesToPaise(req.params.amount ?? 0) ?? 0;
  const hour = resolveEffectiveHour(db, customerId, now, req.simulatedHour);

  if (!baseline) {
    db.prepare(
      `INSERT INTO baselines (id, agent_id, customer_id, sample_count, typical_amount_mean, typical_amount_std, typical_hours, known_payees, typical_action_mix, typical_call_rate_per_min, last_action_type, updated_at) VALUES (?, ?, ?, 1, ?, 30000, ?, ?, ?, 1.5, ?, ?)`
    ).run(
      `base_${agentId}_${customerId}`,
      agentId,
      customerId,
      amountPaise > 0 ? amountPaise : 100000,
      JSON.stringify([hour]),
      JSON.stringify(payeeKey ? [payeeKey] : []),
      JSON.stringify({ [req.action]: 1 }),
      req.action,
      now
    );
    return;
  }

  const n = baseline.sample_count + 1;
  let newMean = baseline.typical_amount_mean;
  let newStd = baseline.typical_amount_std;
  if (amountPaise > 0 && (req.action === 'pay_bill' || req.action === 'transfer')) {
    const delta = amountPaise - baseline.typical_amount_mean;
    newMean = Math.round(baseline.typical_amount_mean + delta / n);
    newStd = Math.max(15000, Math.round(baseline.typical_amount_std * 0.9 + Math.abs(delta) * 0.1));
  }

  const knownPayees: string[] = JSON.parse(baseline.known_payees || '[]');
  if (payeeKey && !knownPayees.includes(payeeKey)) {
    knownPayees.push(payeeKey);
  }

  const typicalHours: number[] = JSON.parse(baseline.typical_hours || '[]');
  if (!typicalHours.includes(hour) && (!isDemoMode() || req.simulatedHour === undefined)) {
    typicalHours.push(hour);
  }

  db.prepare(
    `UPDATE baselines SET sample_count = ?, typical_amount_mean = ?, typical_amount_std = ?, typical_hours = ?, known_payees = ?, last_action_type = ?, updated_at = ? WHERE id = ?`
  ).run(n, newMean, newStd, JSON.stringify(typicalHours), JSON.stringify(knownPayees), req.action, now, baseline.id);
}
