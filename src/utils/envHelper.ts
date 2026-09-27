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
    const cleanValue = value.replace(/[\r\n]/g, '').trim();
    if (!cleanKey) return;

    let content = '';
    if (fs.existsSync(envFilePath)) {
      content = fs.readFileSync(envFilePath, 'utf8');
    }
    
    const lines = content.split(/\r?\n/);
    let found = false;
    
    // We check for both short name and legacy WEIBO_ prefixed name
    const matchesKey = (lineKey: string) => {
      return lineKey === cleanKey || lineKey === `WEIBO_${cleanKey}`;
    };
    
    const updatedLines = lines.map(line => {
      const trimmed = line.trim();
      
      // If line is commented out but matches key, uncomment it and update the value
      if (trimmed.startsWith('#')) {
        const match = trimmed.match(/^#\s*([A-Za-z0-9_]+)\s*=(.*)$/);
        if (match && matchesKey(match[1].trim())) {
          found = true;
          return `${match[1].trim()}=${value}`;
        }
        return line;
      }
      
      const parts = trimmed.split('=');
      if (parts.length >= 2 && matchesKey(parts[0].trim())) {
        found = true;
        // Keep the exact key name used in the file
        return `${parts[0].trim()}=${value}`;
      }
      return line;
    });
    
    if (!found) {
      updatedLines.push(`${key}=${value}`);
    }
    
    fs.writeFileSync(envFilePath, updatedLines.join('\n'), 'utf8');
    
    // Also hot-reload into process.env and in-memory config
    process.env[key] = value;
    process.env[`WEIBO_${key}`] = value; // keep legacy in-sync
    updateConfigInMemory(key, value);
    
    logger.info(`Updated .env variable ${key} to ${value} and hot-reloaded.`);
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
  
  const conf = config as any;
  
  switch (normKey) {
    case 'USER_ID_LIST': conf.USER_ID_LIST = value; break;
    case 'START_DATE': conf.START_DATE = value || null; break;
    case 'END_DATE': conf.END_DATE = value || null; break;
    case 'DATE_ORDER': conf.DATE_ORDER = value; break;
    case 'LOGIN_MODE': conf.LOGIN_MODE = value; break;
    case 'HEADLESS': conf.HEADLESS = parseBool(value); break;
    case 'STATE_FILE': conf.STATE_FILE = value; break;
    
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
    
    case 'DB_TYPE': conf.DB_TYPE = value ? value.toLowerCase() : null; break;
    case 'DB_URI': conf.DB_URI = value; break;
  }
}
