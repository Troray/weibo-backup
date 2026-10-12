/**
 * Escape HTML special characters for Telegram Bot API HTML parse_mode.
 */
export function escapeHtml(str: string): string {
  if (!str) return '';
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * Converts Telegram HTML-formatted text into Markdown / Plain text for webhooks
 * like DingTalk, WeChat Work, Feishu, Lark, and terminal console logs.
 */
export function htmlToPlainTextOrMarkdown(html: string): string {
  if (!html) return '';

  // Transform blockquote content so every line inside blockquote has '> '
  let text = html.replace(/<blockquote(?: expandable)?>([\s\S]*?)<\/blockquote>/gi, (_, content: string) => {
    const lines = content.trim().split(/\r?\n/);
    return lines.map((line: string) => `> ${line}`).join('\n') + '\n';
  });

  return text
    .replace(/<b>(.*?)<\/b>/gi, '**$1**')
    .replace(/<strong>(.*?)<\/strong>/gi, '**$1**')
    .replace(/<i>(.*?)<\/i>/gi, '*$1*')
    .replace(/<em>(.*?)<\/em>/gi, '*$1*')
    .replace(/<code>(.*?)<\/code>/gi, '`$1`')
    .replace(/<pre>(.*?)<\/pre>/gis, '```\n$1\n```')
    .replace(/<a\s+[^>]*href=["']([^"']*)["'][^>]*>(.*?)<\/a>/gi, '$2 ($1)')
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"');
}
