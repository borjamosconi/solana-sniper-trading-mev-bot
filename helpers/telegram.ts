import axios from 'axios';
import { logger } from './logger';
import { TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID, TELEGRAM_ENABLED } from './constants';

/**
 * Fire-and-forget Telegram alert. No-op when disabled or misconfigured.
 * Never throws into the trade path; never logs the bot token.
 */
export async function sendTelegramAlert(text: string): Promise<void> {
  if (!TELEGRAM_ENABLED) return;
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) {
    logger.warn('Telegram alerts enabled but TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID is missing');
    return;
  }

  try {
    await axios.post(
      `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`,
      {
        chat_id: TELEGRAM_CHAT_ID,
        text,
        disable_web_page_preview: true,
      },
      { timeout: 8_000 },
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.warn({ err: message }, 'Failed to send Telegram alert');
  }
}
