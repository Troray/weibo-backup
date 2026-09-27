import { logger } from './logger';

const ALPHABET = "0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ";

/**
 * Decode a Base62 string chunk to decimal number
 */
function decodeBase62Chunk(str: string): number {
  let val = 0;
  for (let i = 0; i < str.length; i++) {
    const char = str[i];
    const index = ALPHABET.indexOf(char);
    if (index === -1) {
      throw new Error(`Invalid Base62 character: ${char}`);
    }
    val = val * 62 + index;
  }
  return val;
}

/**
 * Encode a decimal number to Base62 string chunk
 */
function encodeBase62Chunk(num: number): string {
  if (num === 0) return ALPHABET[0];
  let str = "";
  let temp = num;
  while (temp > 0) {
    str = ALPHABET[temp % 62] + str;
    temp = Math.floor(temp / 62);
  }
  return str;
}

/**
 * Convert Weibo alphanumeric BID to numerical MID
 */
export function bidToMid(bid: string): string {
  if (!bid) return "";
  let mid = "";
  // Process right-to-left in segments of up to 4 characters
  for (let i = bid.length; i > 0; i -= 4) {
    const start = Math.max(0, i - 4);
    const chunk = bid.substring(start, i);
    let dec = decodeBase62Chunk(chunk).toString();
    if (start > 0) {
      dec = dec.padStart(7, '0');
    }
    mid = dec + mid;
  }
  return mid;
}

/**
 * Convert Weibo numerical MID to alphanumeric BID
 */
export function midToBid(mid: string): string {
  if (!mid) return "";
  let bid = "";
  // Process right-to-left in segments of up to 7 digits
  for (let i = mid.length; i > 0; i -= 7) {
    const start = Math.max(0, i - 7);
    const chunk = mid.substring(start, i);
    let enc = encodeBase62Chunk(parseInt(chunk, 10));
    if (start > 0) {
      enc = enc.padStart(4, '0');
    }
    bid = enc + bid;
  }
  return bid;
}

/**
 * Resolves a numerical MID from any input (URL, BID, or MID)
 */
export function resolveMid(input: string): string {
  const cleanInput = input.trim();
  if (!cleanInput) {
    throw new Error("Input string is empty");
  }

  // 1. If it's a URL, extract the last path segment
  // E.g., https://weibo.com/7928198622/R6ytzETBt
  // E.g., https://weibo.com/detail/5315624974686383
  // E.g., https://m.weibo.cn/status/R6ytzETBt
  if (cleanInput.includes("/") || cleanInput.includes("\\")) {
    const parts = cleanInput.split(/[/\\]/);
    const lastPart = parts.filter(Boolean).pop();
    if (!lastPart) {
      throw new Error(`Failed to extract ID from URL: ${cleanInput}`);
    }
    return resolveId(lastPart);
  }

  return resolveId(cleanInput);
}

/**
 * Resolves ID string directly (decides whether it is MID or BID)
 */
function resolveId(idStr: string): string {
  const cleanId = idStr.split(/[?#]/)[0]; // Remove query params or hashes
  if (/^\d+$/.test(cleanId)) {
    return cleanId; // Already a numerical MID
  }
  
  // It contains letters, treat as BID and convert to MID
  try {
    const mid = bidToMid(cleanId);
    logger.debug(`Converted BID "${cleanId}" to MID "${mid}"`);
    return mid;
  } catch (err: any) {
    throw new Error(`Invalid ID or BID representation: "${cleanId}". Details: ${err.message}`);
  }
}
