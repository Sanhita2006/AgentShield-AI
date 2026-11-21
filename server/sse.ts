import type { Response } from 'express';
import type { UserRole } from './types.ts';

export interface SseClient {
  id: string;
  res: Response;
  role: UserRole;
  customerId: string | null;
}

const clients = new Map<string, SseClient>();

export function addSseClient(id: string, res: Response, role: UserRole, customerId: string | null): void {
  clients.set(id, { id, res, role, customerId });
}

export function removeSseClient(id: string): void {
  clients.delete(id);
}

function ownerOf(data: unknown): string | null {
  if (data && typeof data === 'object') {
    const d = data as Record<string, unknown>;
    const v = d.customerId ?? d.customer_id;
    if (typeof v === 'string') return v;
  }
  return null;
}

/**
 * Events that carry a customer id are delivered only to that customer and to bank admins.
 * Events without one (grant/agent/settings/reset notices) carry no account data and go to everyone.
 */
export function broadcastSseEvent(eventType: string, data: unknown): void {
  const owner = ownerOf(data);
  const payload = `event: ${eventType}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const [id, client] of clients.entries()) {
    if (owner && client.role !== 'bank_admin' && client.customerId !== owner) continue;
    try {
      client.res.write(payload);
    } catch {
      clients.delete(id);
    }
  }
}

export function getSseClientCount(): number {
  return clients.size;
}
