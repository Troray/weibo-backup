import * as path from 'path';

/**
 * 将时间字符串或 Date 对象转换为北京时间 (UTC+8) 的紧凑时间戳: YYYYMMDD_HHmmss
 * 遵循国际文件系统与数码资产归档规范（标准可排序列、精确到秒以防同分钟内多条微博冲突）。
 */
export function formatMediaTimePrefix(timeInput: string | Date | undefined): string {
  let d: Date;
  if (!timeInput) {
    d = new Date();
  } else if (typeof timeInput === 'string') {
    let str = timeInput.trim();
    // 兼容无时区后缀的日期时间格式（如 "2026-07-10 17:11:37" 或 "2026-07-10T17:11:37"）
    // 微博时间天然为北京时间(UTC+8)，若宿主机环境时区为 UTC (如海外 VPS/Docker)，避免被原生 Date 解析为 UTC 导致多加 8 小时
    if (/^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}(:\d{2})?$/.test(str)) {
      str = str.replace(' ', 'T') + (str.length <= 16 ? ':00' : '') + '+08:00';
    }
    d = new Date(str);
    if (isNaN(d.getTime())) d = new Date();
  } else {
    d = timeInput;
  }

  // 严格换算为北京时间 (UTC+8)
  const beijingMs = d.getTime() + 8 * 3600 * 1000;
  const beijingDate = new Date(beijingMs);
  const pad = (n: number) => String(n).padStart(2, '0');

  const y = beijingDate.getUTCFullYear();
  const m = pad(beijingDate.getUTCMonth() + 1);
  const day = pad(beijingDate.getUTCDate());
  const h = pad(beijingDate.getUTCHours());
  const min = pad(beijingDate.getUTCMinutes());
  const s = pad(beijingDate.getUTCSeconds());

  return `${y}${m}${day}_${h}${min}${s}`;
}

/**
 * 从 CDN 链接或文件名中提取真实文件扩展名
 */
export function getExtensionFromUrl(urlStr: string, defaultExt: string): string {
  if (!urlStr || typeof urlStr !== 'string') return defaultExt;
  try {
    const parsed = new URL(urlStr);
    let pathname = parsed.pathname;
    if (pathname.includes('?')) {
      pathname = pathname.split('?')[0];
    }
    const ext = path.extname(pathname).toLowerCase();
    if (ext && ext.length >= 2 && ext.length <= 6) {
      return ext;
    }
  } catch {
    const extMatch = urlStr.match(/\.([a-zA-Z0-9]{2,5})(?:[?#]|$)/);
    if (extMatch && extMatch[1]) {
      return `.${extMatch[1].toLowerCase()}`;
    }
  }
  return defaultExt;
}

/**
 * 构造国际通用规范的微博正文媒体文件名:
 * 格式: {YYYYMMDD}_{HHmmss}_{博文ID}_{序号}.{扩展名}
 * 例如: 20260710_171137_5319179567632882_1.jpg
 */
export function buildMediaFilename(
  timeInput: string | Date | undefined,
  postId: string,
  index: number,
  urlStr: string,
  defaultExt: string
): string {
  const timePrefix = formatMediaTimePrefix(timeInput);
  const ext = getExtensionFromUrl(urlStr, defaultExt);
  return `${timePrefix}_${postId}_${index}${ext}`;
}

/**
 * 校验文件名是否已经符合新规范 (用于断点跳过与幂等迁移判断)
 */
export function isStandardMediaFilename(filename: string): boolean {
  return /^\d{8}_\d{6}_\d+_\d+\.[a-zA-Z0-9]+$/i.test(path.basename(filename));
}
