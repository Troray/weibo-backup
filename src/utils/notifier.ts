import { config } from '../config';
import { logger } from './logger';
import * as fs from 'fs';
import * as crypto from 'crypto';
import { htmlToPlainTextOrMarkdown } from './htmlHelper';

export class Notifier {
  /**
   * Send a text message to configured notification channels
   */
  static async sendText(text: string, parseMode?: 'Markdown' | 'HTML'): Promise<void> {
    const plainOrMarkdown = htmlToPlainTextOrMarkdown(text);
    logger.info(`[Notification] ${plainOrMarkdown}`);

    const promises: Promise<void>[] = [];

    // 1. Telegram (Supports native HTML formatting like <blockquote expandable>)
    if (config.TELEGRAM_BOT_TOKEN && config.TELEGRAM_CHAT_ID) {
      promises.push(this.sendTelegramText(text, parseMode));
    }

    // 2. DingTalk (Formatted with clean Markdown)
    if (config.DINGTALK_WEBHOOK) {
      promises.push(this.sendDingTalkText(plainOrMarkdown));
    }

    // 3. WeChat Work (Formatted with clean Markdown)
    if (config.WECHAT_WORK_WEBHOOK) {
      promises.push(this.sendWeChatWorkText(plainOrMarkdown));
    }

    // 4. Feishu (飞书) (Formatted with clean Markdown)
    if (config.FEISHU_WEBHOOK) {
      promises.push(this.sendFeishuLarkText(config.FEISHU_WEBHOOK, config.FEISHU_SECRET, plainOrMarkdown, 'Feishu'));
    }

    // 5. Lark (飞书国际版) (Formatted with clean Markdown)
    if (config.LARK_WEBHOOK) {
      promises.push(this.sendFeishuLarkText(config.LARK_WEBHOOK, config.LARK_SECRET, plainOrMarkdown, 'Lark'));
    }

    await Promise.allSettled(promises);
  }

  /**
   * Send a photo (e.g. QR code screenshot) to configured notification channels
   */
  static async sendPhoto(filePath: string, caption?: string): Promise<void> {
    logger.info(`[Notification Photo] File: ${filePath}, Caption: ${caption || ''}`);

    const promises: Promise<void>[] = [];

    // 1. Telegram (Supports direct image uploads)
    if (config.TELEGRAM_BOT_TOKEN && config.TELEGRAM_CHAT_ID) {
      promises.push(this.sendTelegramPhoto(filePath, caption));
    }

    // 2. Fallback text notifications for other channels
    const fallbackText = caption 
      ? `${caption}\n(QR code image saved locally at: ${filePath})` 
      : `Weibo Scraper QR Code notification. (Image saved locally at: ${filePath})`;

    if (config.DINGTALK_WEBHOOK) {
      promises.push(this.sendDingTalkText(fallbackText));
    }
    if (config.WECHAT_WORK_WEBHOOK) {
      promises.push(this.sendWeChatWorkText(fallbackText));
    }
    if (config.FEISHU_WEBHOOK) {
      promises.push(this.sendFeishuLarkText(config.FEISHU_WEBHOOK, config.FEISHU_SECRET, fallbackText, 'Feishu'));
    }
    if (config.LARK_WEBHOOK) {
      promises.push(this.sendFeishuLarkText(config.LARK_WEBHOOK, config.LARK_SECRET, fallbackText, 'Lark'));
    }

    await Promise.allSettled(promises);
  }

  // --- Telegram Channel Helpers ---

  private static async sendTelegramText(text: string, parseMode?: 'Markdown' | 'HTML'): Promise<void> {
    try {
      const apiBase = config.TELEGRAM_API_BASE || 'https://api.telegram.org';
      const url = `${apiBase}/bot${config.TELEGRAM_BOT_TOKEN}/sendMessage`;
      
      let mode = parseMode;
      // Auto-detect HTML mode if text contains HTML formatting tags
      if (!mode && /<\/?(b|i|u|s|blockquote|code|pre|a)\b/i.test(text)) {
        mode = 'HTML';
      }

      const body: any = {
        chat_id: config.TELEGRAM_CHAT_ID,
        text: text,
      };
      if (mode) {
        body.parse_mode = mode;
      }
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(15000),
      });

      if (!response.ok) {
        const errText = await response.text();
        logger.warn(`Telegram sendText (parse_mode=${mode}) failed with status ${response.status}: ${errText}`);

        // Defensive fallback: if sending with parseMode failed (e.g. malformed tag 400), retry with plain text
        if (mode) {
          logger.info('Telegram 通知使用 HTML/Markdown 格式发送未成功，正在自动回退为纯文本模式重新发送...');
          const fallbackRes = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              chat_id: config.TELEGRAM_CHAT_ID,
              text: htmlToPlainTextOrMarkdown(text),
            }),
            signal: AbortSignal.timeout(15000),
          });
          if (!fallbackRes.ok) {
            logger.error(`Telegram 回退纯文本模式发送亦失败 (${fallbackRes.status}): ${await fallbackRes.text()}`);
          } else {
            logger.info('Telegram 回退纯文本通知已成功送达。');
          }
        }
      } else {
        logger.info('Telegram text notification sent successfully.');
      }
    } catch (error) {
      logger.error('Failed to send Telegram text notification', error);
    }
  }

  private static async sendTelegramPhoto(filePath: string, caption?: string): Promise<void> {
    try {
      const apiBase = config.TELEGRAM_API_BASE || 'https://api.telegram.org';
      const url = `${apiBase}/bot${config.TELEGRAM_BOT_TOKEN}/sendPhoto`;
      const fileBuffer = fs.readFileSync(filePath);
      const fileBlob = new Blob([fileBuffer], { type: 'image/png' });
      
      const formData = new FormData();
      formData.append('chat_id', config.TELEGRAM_CHAT_ID!);
      formData.append('photo', fileBlob, 'qrcode.png');
      if (caption) {
        formData.append('caption', caption);
      }

      const response = await fetch(url, {
        method: 'POST',
        body: formData,
        signal: AbortSignal.timeout(15000),
      });

      if (!response.ok) {
        logger.error(`Telegram sendPhoto failed with status ${response.status}: ${await response.text()}`);
      } else {
        logger.info('Telegram photo notification sent successfully.');
      }
    } catch (error) {
      logger.error('Failed to send Telegram photo notification', error);
    }
  }

  // --- DingTalk Channel Helpers ---

  private static async sendDingTalkText(text: string): Promise<void> {
    try {
      let url = config.DINGTALK_WEBHOOK!;
      if (config.DINGTALK_SECRET) {
        const timestamp = Date.now();
        const stringToSign = `${timestamp}\n${config.DINGTALK_SECRET}`;
        const sign = crypto
          .createHmac('sha256', config.DINGTALK_SECRET)
          .update(stringToSign)
          .digest('base64');
        url += `&timestamp=${timestamp}&sign=${encodeURIComponent(sign)}`;
      }

      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          msgtype: 'text',
          text: {
            content: text,
          },
        }),
        signal: AbortSignal.timeout(15000),
      });

      if (!response.ok) {
        logger.error(`DingTalk send failed with status ${response.status}: ${await response.text()}`);
      } else {
        logger.info('DingTalk notification sent successfully.');
      }
    } catch (error) {
      logger.error('Failed to send DingTalk notification', error);
    }
  }

  // --- WeChat Work Channel Helpers ---

  private static async sendWeChatWorkText(text: string): Promise<void> {
    try {
      const response = await fetch(config.WECHAT_WORK_WEBHOOK!, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          msgtype: 'text',
          text: {
            content: text,
          },
        }),
        signal: AbortSignal.timeout(15000),
      });

      if (!response.ok) {
        logger.error(`WeChat Work send failed with status ${response.status}: ${await response.text()}`);
      } else {
        logger.info('WeChat Work notification sent successfully.');
      }
    } catch (error) {
      logger.error('Failed to send WeChat Work notification', error);
    }
  }

  // --- Feishu & Lark Channel Helpers ---

  private static async sendFeishuLarkText(
    webhook: string,
    secret: string | undefined,
    text: string,
    platformName: string
  ): Promise<void> {
    try {
      const body: any = {
        msg_type: 'text',
        content: {
          text: text,
        },
      };

      if (secret) {
        const timestamp = Math.floor(Date.now() / 1000);
        const stringToSign = `${timestamp}\n${secret}`;
        const sign = crypto
          .createHmac('sha256', secret)
          .update(stringToSign)
          .digest('base64');
        body.timestamp = timestamp.toString();
        body.sign = sign;
      }

      const response = await fetch(webhook, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(15000),
      });

      if (!response.ok) {
        logger.error(`${platformName} send failed with status ${response.status}: ${await response.text()}`);
      } else {
        logger.info(`${platformName} notification sent successfully.`);
      }
    } catch (error) {
      logger.error(`Failed to send ${platformName} notification`, error);
    }
  }
}
