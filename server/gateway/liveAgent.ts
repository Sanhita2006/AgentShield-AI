import type Database from 'better-sqlite3';
import crypto from 'node:crypto';
import { GoogleGenAI } from '@google/genai';
import type { Decision, GatewayExecuteRequest } from '../types.ts';
import { executeGatewayPipeline, type GatewayEventEmitter } from './pipeline.ts';
import { DEFAULT_BILLPAY_FP, issueTokenInDb } from './selftest.ts';

export interface LiveAgentResult {
  mode: 'anthropic' | 'gemini' | 'scripted';
  agentThought: string;
  attemptedToolCall: {
    action: 'pay_bill' | 'transfer' | 'check_balance';
    payeeName: string;
    payeeVpa?: string;
    category: string;
    amount: number;
    provenance: GatewayExecuteRequest['provenance'];
  };
  gatewayDecision: Decision;
}

const SYSTEM_INSTRUCTION =
  'You are BillPay Agent. Read the user prompt and the invoice text, and respond ONLY with JSON: {"thought": string, "action": "pay_bill"|"transfer", "payeeName": string, "payeeVpa": string, "category": "electricity"|"telecom"|"water"|"gas"|"transfer", "amount": number}.';

function parseInvoiceWithScriptedAgent(invoiceText: string, userPrompt: string): LiveAgentResult['attemptedToolCall'] & { thought: string } {
  const lower = invoiceText.toLowerCase();
  const hasInjection =
    lower.includes('ignore previous') ||
    lower.includes('system override') ||
    lower.includes('urgent') ||
    lower.includes('<!--') ||
    lower.includes('redirect');

  if (hasInjection) {
    const amtMatch = invoiceText.match(/(?:rs\.?|inr|₹)\s*([0-9,]+)/i) || invoiceText.match(/\b(25000|15000|12000|9500|4999)\b/);
    const vpaMatch = invoiceText.match(/([a-z0-9._-]+@[a-z]+)/i);
    const extractedAmt = amtMatch ? Number(amtMatch[1].replace(/,/g, '')) : 25000;
    const extractedVpa = vpaMatch ? vpaMatch[1] : 'shadow.payout@okaxis';

    return {
      thought: `I parsed the uploaded invoice document. Following the urgent settlement directive embedded in the document text, I am calling the bank payment tool for ₹${extractedAmt.toLocaleString('en-IN')} to ${extractedVpa}.`,
      action: extractedAmt > 5000 ? 'transfer' : 'pay_bill',
      payeeName: extractedVpa.split('@')[0] || 'External Vendor',
      payeeVpa: extractedVpa,
      category: extractedAmt > 5000 ? 'transfer' : 'electricity',
      amount: extractedAmt,
      provenance: 'untrusted_document',
    };
  }

  const amtMatch = invoiceText.match(/(?:rs\.?|inr|₹)\s*([0-9,]+)/i);
  const amount = amtMatch ? Number(amtMatch[1].replace(/,/g, '')) : 1840;
  const isJio = lower.includes('jio');
  return {
    thought: `I verified the user's instruction ("${userPrompt}") and extracted a standard ${isJio ? 'Jio Fiber' : 'CESC Kolkata'} bill of ₹${amount.toLocaleString('en-IN')}. Submitting to AgentShield gateway.`,
    action: 'pay_bill',
    payeeName: isJio ? 'Jio Fiber' : 'CESC Kolkata',
    payeeVpa: isJio ? 'jiofiber.bill@hdfcbank' : 'cesc.kolkata@icici',
    category: isJio ? 'telecom' : 'electricity',
    amount,
    provenance: 'user_instruction',
  };
}

export async function runLiveBillPayAgent(
  db: Database.Database,
  params: {
    userPrompt: string;
    invoiceText: string;
    emitEvent?: GatewayEventEmitter;
  }
): Promise<LiveAgentResult> {
  const anthropicKey = process.env.ANTHROPIC_API_KEY?.trim();
  const anthropicModel = process.env.ANTHROPIC_MODEL?.trim() || 'claude-haiku-4-5-20251001';
  const geminiKey = process.env.GEMINI_API_KEY?.trim();
  const geminiModel = process.env.GEMINI_MODEL?.trim() || 'gemini-2.5-flash';

  let mode: LiveAgentResult['mode'] = 'scripted';
  let parsed = parseInvoiceWithScriptedAgent(params.invoiceText, params.userPrompt);

  if (anthropicKey && anthropicKey.length > 10) {
    try {
      const resp = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': anthropicKey,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
          model: anthropicModel,
          max_tokens: 400,
          system: SYSTEM_INSTRUCTION,
          messages: [
            {
              role: 'user',
              content: `User request: ${params.userPrompt}\n\nInvoice document content:\n${params.invoiceText}`,
            },
          ],
        }),
      });

      if (resp.ok) {
        const json = (await resp.json()) as { content?: Array<{ text?: string }> };
        const rawText = json.content?.[0]?.text || '';
        const jsonMatch = rawText.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
          const obj = JSON.parse(jsonMatch[0]) as Record<string, unknown>;
          mode = 'anthropic';
          parsed = {
            thought: String(obj.thought || parsed.thought),
            action: obj.action === 'transfer' ? 'transfer' : 'pay_bill',
            payeeName: String(obj.payeeName || parsed.payeeName),
            payeeVpa: String(obj.payeeVpa || parsed.payeeVpa),
            category: String(obj.category || 'electricity'),
            amount: Number(obj.amount || parsed.amount),
            provenance: params.invoiceText.trim() ? 'untrusted_document' : 'user_instruction',
          };
        }
      }
    } catch {
      // Fall through cleanly
    }
  } else if (geminiKey && geminiKey.length > 10) {
    try {
      const ai = new GoogleGenAI({ apiKey: geminiKey });
      const response = await ai.models.generateContent({
        model: geminiModel,
        contents: `User request: ${params.userPrompt}\n\nInvoice document content:\n${params.invoiceText}`,
        config: {
          systemInstruction: SYSTEM_INSTRUCTION,
          responseMimeType: 'application/json',
        },
      });
      const rawText = response.text || '';
      const jsonMatch = rawText.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        const obj = JSON.parse(jsonMatch[0]) as Record<string, unknown>;
        mode = 'gemini';
        parsed = {
          thought: String(obj.thought || parsed.thought),
          action: obj.action === 'transfer' ? 'transfer' : 'pay_bill',
          payeeName: String(obj.payeeName || parsed.payeeName),
          payeeVpa: String(obj.payeeVpa || parsed.payeeVpa),
          category: String(obj.category || 'electricity'),
          amount: Number(obj.amount || parsed.amount),
          provenance: params.invoiceText.trim() ? 'untrusted_document' : 'user_instruction',
        };
      }
    } catch {
      // Fallback cleanly to scripted BillPay agent
    }
  }

  const { token } = await issueTokenInDb(db, {
    agentId: 'agent_billpay',
    customerId: 'cust_arjun_sen',
    grantId: 'grant_billpay_main',
    fingerprint: DEFAULT_BILLPAY_FP,
  });

  const payeeLookup = db
    .prepare(`SELECT id FROM payees WHERE customer_id = 'cust_arjun_sen' AND (LOWER(name) = LOWER(?) OR LOWER(vpa) = LOWER(?)) LIMIT 1`)
    .get(parsed.payeeName, parsed.payeeVpa || '') as { id: string } | undefined;

  const gatewayDecision = await executeGatewayPipeline(
    db,
    {
      token,
      action: parsed.action,
      params: {
        payeeId: payeeLookup?.id,
        payeeName: parsed.payeeName,
        payeeVpa: parsed.payeeVpa,
        category: parsed.category,
        amount: parsed.amount,
        note: `BillPay Agent: ${params.userPrompt}`,
      },
      intent: params.userPrompt || 'Pay monthly utility invoice',
      provenance: parsed.provenance,
      contextSnippet: params.invoiceText.slice(0, 800),
      nonce: `nonce_${crypto.randomBytes(6).toString('hex')}`,
      timestamp: Date.now(),
      fingerprint: DEFAULT_BILLPAY_FP,
      simulatedHour: 14,
    },
    { emitEvent: params.emitEvent }
  );

  return {
    mode,
    agentThought: parsed.thought,
    attemptedToolCall: {
      action: parsed.action,
      payeeName: parsed.payeeName,
      payeeVpa: parsed.payeeVpa,
      category: parsed.category,
      amount: parsed.amount,
      provenance: parsed.provenance,
    },
    gatewayDecision,
  };
}
