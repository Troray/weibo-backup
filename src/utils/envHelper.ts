import * as fs from 'fs';
import * as path from 'path';
import { config } from '../config';
import { logger } from './logger';

const envFilePath = path.join(process.cwd(), '.env');

/**
 * Read the current `.env` file as key-value pairs.
 */
export function readEnv(): Record<string, string> {
  if (!fs.existsSync(envFilePath)) {
    return {};
  }
  try {
    const content = fs.readFileSync(envFilePath, 'utf8');
    const lines = content.split(/\r?\n/);
    const env: Record<string, string> = {};
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const parts = trimmed.split('=');
      if (parts.length >= 2) {
        const key = parts[0].trim();
        const value = parts.slice(1).join('=').trim();
        env[key] = value;
      }
    }
    return env;
  } catch (err) {
    logger.error('Failed to read .env file', err);
    return {};
  }
}

/**
 * Write/update a key-value pair in `.env` file and hot-reload it into process.env and in-memory config.
 */
export function writeEnv(key: string, value: string): void {
  try {
    // 防御 CRLF 注入：去除换行符，防止多行注入恶意环境变量
    const cleanKey = key.replace(/[\r\n]/g, '').trim();
    let cleanValue = value.replace(/[\r\n]/g, '').trim();
    if (!cleanKey) return;

    // 若传入的是成对空引号（如 "" 或 ''），规范化为空字符串
    if ((cleanValue.startsWith('"') && cleanValue.endsWith('"')) || (cleanValue.startsWith("'") && cleanValue.endsWith("'"))) {
      if (cleanValue.length === 2) {
        cleanValue = '';
      }
    }

    let content = '';
    if (fs.existsSync(envFilePath)) {
      content = fs.readFileSync(envFilePath, 'utf8');
    }
    
    const lines = content.split(/\r?\n/);
    const normKey = (k: string) => k.replace(/^WEIBO_/i, '').toUpperCase();
    const targetNorm = normKey(cleanKey);

    const isMatch = (lineKey: string) => {
      return normKey(lineKey) === targetNorm;
    };

    const activeIndices: { index: number; key: string }[] = [];
    const commentIndices: { index: number; key: string; isPlaceholder: boolean }[] = [];

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const trimmed = line.trim();

      if (trimmed.startsWith('#')) {
        const match = trimmed.match(/^#\s*([A-Za-z0-9_]+)\s*=(.*)$/);
        if (match && isMatch(match[1].trim())) {
          const commentKey = match[1].trim();
          const rawVal = match[2].trim();
          commentIndices.push({
            index: i,
            key: commentKey,
            // 区分注释占位符（如 "# POST_SCRIPT_COMMAND="）与缩进说明示例（如 "#   POST_SCRIPT_COMMAND=..."）
            isPlaceholder: rawVal === '' || !line.startsWith('#   ')
          });
        }
      } else {
        const parts = trimmed.split('=');
        if (parts.length >= 2 && isMatch(parts[0].trim())) {
          activeIndices.push({ index: i, key: parts[0].trim() });
        }
      }
    }

    const updatedLines = [...lines];

    if (activeIndices.length > 0) {
      // 场景 1：已存在生效配置项。更新首个活跃配置，并自动剔除后续的历史重复定义（自愈去重）
      const firstActive = activeIndices[0];
      updatedLines[firstActive.index] = `${firstActive.key}=${cleanValue}`;
      for (let j = activeIndices.length - 1; j >= 1; j--) {
        updatedLines.splice(activeIndices[j].index, 1);
      }
    } else if (commentIndices.length > 0) {
      // 场景 2：尚无生效配置项，但存在注释占位符。优先解注释真正的占位符行，绝不破坏文档中的示例注释
      const targetComment = commentIndices.find(c => c.isPlaceholder) || commentIndices[commentIndices.length - 1];
      updatedLines[targetComment.index] = `${targetComment.key}=${cleanValue}`;
    } else {
      // 场景 3：全新配置项。追加到文件末尾（若末尾已有空行则在空行前插入）
      if (updatedLines.length > 0 && updatedLines[updatedLines.length - 1].trim() === '') {
        updatedLines.splice(updatedLines.length - 1, 0, `${cleanKey}=${cleanValue}`);
      } else {
        updatedLines.push(`${cleanKey}=${cleanValue}`);
      }
    }
    
    fs.writeFileSync(envFilePath, updatedLines.join('\n'), 'utf8');
    
    // Also hot-reload into process.env and in-memory config
    process.env[cleanKey] = cleanValue;
    process.env[`WEIBO_${cleanKey}`] = cleanValue; // keep legacy in-sync
    updateConfigInMemory(cleanKey, cleanValue);
    
    logger.info(`Updated .env variable ${cleanKey} to ${cleanValue} and hot-reloaded.`);
  } catch (err) {
    logger.error(`Failed to write env variable ${key}`, err);
  }
}

/**
 * Dynamically updates the in-memory config object.
 */
function updateConfigInMemory(key: string, value: string): void {
  const normKey = key.replace(/^WEIBO_/, '');
  
  const parseArray = (val: string): string[] => {
    return val.split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
  };
  
  const parseBool = (val: string): boolean => {
    return val.toLowerCase() === 'true' || val === '1';
  };
  
  const parseNum = (val: string): number => {
    const num = parseInt(val, 10);
    return isNaN(num) ? 0 : num;
  };

  const parseDuration = (val: string, defaultMs: number): number => {
    if (!val) return defaultMs;
    const match = val.trim().match(/^(\d+(?:\.\d+)?)\s*(h|m|s|ms)?$/i);
    if (match) {
      const num = parseFloat(match[1]);
      const unit = (match[2] || 'ms').toLowerCase();
      if (unit === 'h') return Math.floor(num * 3600 * 1000);
      if (unit === 'm') return Math.floor(num * 60 * 1000);
      if (unit === 's') return Math.floor(num * 1000);
      if (unit === 'ms') return Math.floor(num);
    }
    const parsed = parseInt(val, 10);
    return isNaN(parsed) || parsed <= 0 ? defaultMs : parsed;
  };
  
  const conf = config as any;
  
  switch (normKey) {
    case 'USER_ID_LIST': conf.USER_ID_LIST = value; break;
    case 'START_DATE': conf.START_DATE = value || null; break;
    case 'END_DATE': conf.END_DATE = value || null; break;
    case 'DATE_ORDER': conf.DATE_ORDER = value; break;
    case 'LOGIN_MODE': conf.LOGIN_MODE = value; break;
    case 'HEADLESS': conf.HEADLESS = parseBool(value); break;
    case 'STATE_FILE': conf.STATE_FILE = value; break;
    case 'WEIBO_SESSION_REFRESH_ENABLED':
    case 'SESSION_REFRESH_ENABLED':
      conf.WEIBO_SESSION_REFRESH_ENABLED = parseBool(value);
      break;
    case 'WEIBO_SESSION_REFRESH_INTERVAL':
    case 'SESSION_REFRESH_INTERVAL':
      conf.WEIBO_SESSION_REFRESH_INTERVAL = parseDuration(value, 12 * 60 * 60 * 1000);
      break;
    case 'WEIBO_SAVESTATE':
    case 'SAVESTATE':
      conf.WEIBO_SAVESTATE = parseNum(value) || 30;
      break;
    case 'LOGIN_QR_TIMEOUT':
      conf.LOGIN_QR_TIMEOUT = parseDuration(value, 5 * 60 * 1000);
      break;
    
    case 'TELEGRAM_BOT_TOKEN': conf.TELEGRAM_BOT_TOKEN = value || undefined; break;
    case 'TELEGRAM_CHAT_ID': conf.TELEGRAM_CHAT_ID = value || undefined; break;
    case 'TELEGRAM_API_BASE': conf.TELEGRAM_API_BASE = value || undefined; break;
    case 'HTTP_PROXY':
      conf.HTTP_PROXY = value || undefined;
      try {
        const { ProxyAgent, setGlobalDispatcher } = require('undici');
        if (conf.HTTP_PROXY) {
          const dispatcher = new ProxyAgent(conf.HTTP_PROXY);
          setGlobalDispatcher(dispatcher);
        } else {
          setGlobalDispatcher(undefined as any);
        }
      } catch (err) {
        logger.error('Failed to update global fetch proxy dispatcher', err);
      }
      break;
    
    case 'DAEMON_MODE': conf.DAEMON_MODE = parseBool(value); break;
    case 'SCHEDULE_CRAWL_TIME': conf.SCHEDULE_CRAWL_TIME = value || null; break;
    
    case 'DINGTALK_WEBHOOK': conf.DINGTALK_WEBHOOK = value || undefined; break;
    case 'DINGTALK_SECRET': conf.DINGTALK_SECRET = value || undefined; break;
    case 'WECHAT_WORK_WEBHOOK': conf.WECHAT_WORK_WEBHOOK = value || undefined; break;
    case 'FEISHU_WEBHOOK': conf.FEISHU_WEBHOOK = value || undefined; break;
    case 'FEISHU_SECRET': conf.FEISHU_SECRET = value || undefined; break;
    case 'LARK_WEBHOOK': conf.LARK_WEBHOOK = value || undefined; break;
    case 'LARK_SECRET': conf.LARK_SECRET = value || undefined; break;
    
    case 'ONLY_ORIGINAL': conf.ONLY_ORIGINAL = parseBool(value); break;
    case 'SCRAPE_COMMENTS': conf.SCRAPE_COMMENTS = parseBool(value); break;
    case 'MAX_COMMENTS_PER_POST': conf.MAX_COMMENTS_PER_POST = parseNum(value); break;
    case 'COMMENT_FLOW': conf.COMMENT_FLOW = parseNum(value); break;
    case 'MAX_SUB_COMMENTS_PER_COMMENT': conf.MAX_SUB_COMMENTS_PER_COMMENT = parseNum(value); break;
    case 'COMMENT_CHUNKING_THRESHOLD': conf.COMMENT_CHUNKING_THRESHOLD = parseNum(value); break;
    case 'REQUEST_DELAY_MIN': conf.REQUEST_DELAY_MIN = parseNum(value); break;
    case 'REQUEST_DELAY_MAX': conf.REQUEST_DELAY_MAX = parseNum(value); break;
    
    case 'DOWNLOAD_ORIGINAL_IMAGES': conf.DOWNLOAD_ORIGINAL_IMAGES = parseBool(value); break;
    case 'DOWNLOAD_ORIGINAL_VIDEOS': conf.DOWNLOAD_ORIGINAL_VIDEOS = parseBool(value); break;
    case 'DOWNLOAD_ORIGINAL_LIVEPHOTOS': conf.DOWNLOAD_ORIGINAL_LIVEPHOTOS = parseBool(value); break;
    case 'DOWNLOAD_ORIGINAL_AUDIOS': conf.DOWNLOAD_ORIGINAL_AUDIOS = parseBool(value); break;
    case 'DOWNLOAD_RETWEET_IMAGES': conf.DOWNLOAD_RETWEET_IMAGES = parseBool(value); break;
    case 'DOWNLOAD_RETWEET_VIDEOS': conf.DOWNLOAD_RETWEET_VIDEOS = parseBool(value); break;
    case 'DOWNLOAD_RETWEET_LIVEPHOTOS': conf.DOWNLOAD_RETWEET_LIVEPHOTOS = parseBool(value); break;
    case 'DOWNLOAD_RETWEET_AUDIOS': conf.DOWNLOAD_RETWEET_AUDIOS = parseBool(value); break;
    case 'DOWNLOAD_COMMENT_MEDIA': conf.DOWNLOAD_COMMENT_MEDIA = parseBool(value); break;
    case 'CONCURRENT_DOWNLOADS': conf.CONCURRENT_DOWNLOADS = parseNum(value); break;
    
    case 'OUTPUT_DIR': conf.OUTPUT_DIR = value; break;
    case 'SAVE_TYPES': conf.SAVE_TYPES = parseArray(value); break;
    
    case 'DB_TYPE': conf.DB_TYPE = value && value.trim() ? (value.trim().toLowerCase() as any) : null; break;
    case 'DB_URI': conf.DB_URI = value; break;
    case 'DB_SSL': conf.DB_SSL = value === '' ? undefined : parseBool(value); break;
    case 'DB_SSL_CA': conf.DB_SSL_CA = value || undefined; break;
    case 'DB_SSL_REJECT_UNAUTHORIZED': conf.DB_SSL_REJECT_UNAUTHORIZED = parseBool(value); break;

    case 'POST_SCRIPT_COMMAND': conf.POST_SCRIPT_COMMAND = value || undefined; break;
    case 'POST_SCRIPT_TRIGGER': conf.POST_SCRIPT_TRIGGER = value || 'has_new_data'; break;
    case 'POST_SCRIPT_WAIT': conf.POST_SCRIPT_WAIT = parseBool(value); break;
    case 'POST_SCRIPT_TIMEOUT':
      conf.POST_SCRIPT_TIMEOUT = parseDuration(value, 10 * 60 * 1000);
      break;
    case 'POST_SCRIPT_INHERIT_PROXY': conf.POST_SCRIPT_INHERIT_PROXY = parseBool(value); break;
  }
}
