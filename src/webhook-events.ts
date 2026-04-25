/**
 * Webhook Events — notify external systems
 * HMAC-SHA256 signature via X-Webhook-Signature header
 */
import axios from 'axios';
import crypto from 'crypto';
import { Logger } from './types';

export type WebhookEventType =
  | 'avatar.uploaded' | 'avatar.deleted'
  | 'user.login' | 'user.logout'
  | 'backup.created' | 'ban.issued' | 'test';

export interface WebhookPayload {
  event: WebhookEventType;
  timestamp: string;
  data: Record<string, any>;
}

export interface WebhookEvents {
  emit(event: WebhookEventType, data: Record<string, any>): void;
}

export function createWebhookEvents(
  webhookUrl: string | undefined,
  secret: string | undefined,
  logger: Logger
): WebhookEvents {
  if (!webhookUrl) {
    return { emit() {} }; // no-op
  }

  async function send(payload: WebhookPayload, attempt = 1): Promise<void> {
    const body = JSON.stringify(payload);
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };

    if (secret) {
      const sig = crypto.createHmac('sha256', secret).update(body).digest('hex');
      headers['X-Webhook-Signature'] = `sha256=${sig}`;
    }

    try {
      await axios.post(webhookUrl!, body, { headers, timeout: 5000 });
    } catch (err) {
      if (attempt < 3) {
        await new Promise(r => setTimeout(r, 1000 * attempt));
        return send(payload, attempt + 1);
      }
      logger.warn('Webhook delivery failed', { event: payload.event, error: String(err) });
    }
  }

  return {
    emit(event, data) {
      const payload: WebhookPayload = { event, timestamp: new Date().toISOString(), data };
      send(payload).catch(() => {}); // fire-and-forget
    },
  };
}
