import * as dotenv from 'dotenv';
import * as path from 'path';

// 从 .env 文件中加载环境变量
dotenv.config({ quiet: true });

export type LoginMode = 'TERMINAL_QR' | 'BOT_NOTIFY' | 'LOCAL_SYNC';
export type DbType = 'sqlite' | 'mysql' | 'postgres';
export type DateOrder = 'asc' | 'desc';

export interface ScraperConfig {
  // 目标配置
  USER_ID_LIST: string; // 需要抓取的 UID 列表（支持单用户、多用户以逗号分隔，或者文件名如 userid.txt）
  START_DATE: string | null; // 开始日期（例如 '2026-01-01'）
  END_DATE: string | null; // 结束日期（例如 '2026-07-01'）
  DATE_ORDER: DateOrder; // 日期遍历顺序：asc=从 START 到 END，desc=从 END 到 START
  
  // 登录与通知模式配置
  LOGIN_MODE: LoginMode; // 登录模式：TERMINAL_QR（终端二维码）、BOT_NOTIFY（机器人通知二维码）、LOCAL_SYNC（本地同步）
  HEADLESS: boolean; // [已弃用] 模拟登录已切换为纯 API 浏览器级模拟登录，此选项不再生效
  STATE_FILE: string; // state.json 存储路径
  
  // 机器人通知配置（以 Telegram 为例，可根据需要扩展）
  TELEGRAM_BOT_TOKEN?: string;
  TELEGRAM_CHAT_ID?: string;
  TELEGRAM_API_BASE?: string;
  HTTP_PROXY?: string;
  
  // 守护进程模式
  DAEMON_MODE: boolean;
  SCHEDULE_CRAWL_TIME: string | null; // 每日定时爬取时间 (如 '00:30')

  // 额外通知配置
  DINGTALK_WEBHOOK?: string;
  DINGTALK_SECRET?: string;
  WECHAT_WORK_WEBHOOK?: string;
  FEISHU_WEBHOOK?: string;
  FEISHU_SECRET?: string;
  LARK_WEBHOOK?: string;
  LARK_SECRET?: string;
  
  // 抓取行为控制配置
  ONLY_ORIGINAL: boolean; // 是否仅抓取原创微博（排除转发）
  SCRAPE_COMMENTS: boolean; // 是否抓取评论区
  MAX_COMMENTS_PER_POST: number; // 单条微博最大抓取评论数
  REQUEST_DELAY_MIN: number; // 评论抓取最小延迟（毫秒）
  REQUEST_DELAY_MAX: number; // 评论抓取最大延迟（毫秒）
  
  // 媒体下载配置
  DOWNLOAD_ORIGINAL_IMAGES: boolean; // 是否下载原创微博的高清大图
  DOWNLOAD_ORIGINAL_VIDEOS: boolean; // 是否下载原创微博的超清视频
  DOWNLOAD_ORIGINAL_LIVEPHOTOS: boolean; // 是否下载原创微博的实况照片 (Live Photo)
  DOWNLOAD_RETWEET_IMAGES: boolean; // 是否下载转发微博的媒体图片
  DOWNLOAD_RETWEET_VIDEOS: boolean; // 是否下载转发微博的媒体视频
  DOWNLOAD_RETWEET_LIVEPHOTOS: boolean; // 是否下载转发微博的实况照片 (Live Photo)
  DOWNLOAD_COMMENT_MEDIA: boolean; // 是否下载评论区中包含的媒体文件
  CONCURRENT_DOWNLOADS: number; // 媒体文件并发下载限制数
  
  // 数据持久化输出配置
  OUTPUT_DIR: string; // 文件输出的根目录
  SAVE_TYPES: string[]; // 保存的数据类型格式列表 (如 csv, json, markdown)
  
  // 关系型数据库配置
  DB_TYPE: DbType | null; // 数据库类型（sqlite, mysql, postgres，若留空则为 null）
  DB_URI: string; // 数据库连接地址。SQLite 填写文件路径，MySQL/PG 填写 URI 连接字符串
}

const getEnvArray = (key: string, defaultValue: string[]): string[] => {
  const value = process.env[key] !== undefined ? process.env[key] : process.env[`WEIBO_${key}`];
  if (value === undefined) return defaultValue;
  return value.split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
};

const getEnvBool = (key: string, defaultValue: boolean): boolean => {
  const value = process.env[key] !== undefined ? process.env[key] : process.env[`WEIBO_${key}`];
  if (value === undefined) return defaultValue;
  return value.toLowerCase() === 'true' || value === '1';
};

const getEnvNum = (key: string, defaultValue: number): number => {
  const value = process.env[key] !== undefined ? process.env[key] : process.env[`WEIBO_${key}`];
  if (value === undefined) return defaultValue;
  const num = parseInt(value, 10);
  return isNaN(num) ? defaultValue : num;
};

const getEnvStr = (key: string, defaultValue?: string): string | undefined => {
  const value = process.env[key] !== undefined ? process.env[key] : process.env[`WEIBO_${key}`];
  return value !== undefined ? value : defaultValue;
};

export const config: ScraperConfig = {
  USER_ID_LIST: getEnvStr('USER_ID_LIST', 'userid.txt')!,
  START_DATE: getEnvStr('START_DATE') || null,
  END_DATE: getEnvStr('END_DATE') || null,
  DATE_ORDER: (getEnvStr('DATE_ORDER', 'asc') as DateOrder),
  
  LOGIN_MODE: (getEnvStr('LOGIN_MODE', 'TERMINAL_QR') as LoginMode),
  HEADLESS: getEnvBool('HEADLESS', true),
  STATE_FILE: getEnvStr('STATE_FILE') || path.join(process.cwd(), 'state.json'),
  
  TELEGRAM_BOT_TOKEN: getEnvStr('TELEGRAM_BOT_TOKEN'),
  TELEGRAM_CHAT_ID: getEnvStr('TELEGRAM_CHAT_ID'),
  TELEGRAM_API_BASE: getEnvStr('TELEGRAM_API_BASE', 'https://api.telegram.org'),
  HTTP_PROXY: getEnvStr('HTTP_PROXY'),
  
  DAEMON_MODE: getEnvBool('DAEMON_MODE', false),
  SCHEDULE_CRAWL_TIME: getEnvStr('SCHEDULE_CRAWL_TIME') || null,
  
  DINGTALK_WEBHOOK: getEnvStr('DINGTALK_WEBHOOK'),
  DINGTALK_SECRET: getEnvStr('DINGTALK_SECRET'),
  WECHAT_WORK_WEBHOOK: getEnvStr('WECHAT_WORK_WEBHOOK'),
  FEISHU_WEBHOOK: getEnvStr('FEISHU_WEBHOOK'),
  FEISHU_SECRET: getEnvStr('FEISHU_SECRET'),
  LARK_WEBHOOK: getEnvStr('LARK_WEBHOOK'),
  LARK_SECRET: getEnvStr('LARK_SECRET'),
  
  ONLY_ORIGINAL: getEnvBool('ONLY_ORIGINAL', false),
  SCRAPE_COMMENTS: getEnvBool('SCRAPE_COMMENTS', true),
  MAX_COMMENTS_PER_POST: getEnvNum('MAX_COMMENTS_PER_POST', 50),
  REQUEST_DELAY_MIN: getEnvNum('REQUEST_DELAY_MIN', 1500),
  REQUEST_DELAY_MAX: getEnvNum('REQUEST_DELAY_MAX', 3000),
  
  DOWNLOAD_ORIGINAL_IMAGES: getEnvBool('DOWNLOAD_ORIGINAL_IMAGES', true),
  DOWNLOAD_ORIGINAL_VIDEOS: getEnvBool('DOWNLOAD_ORIGINAL_VIDEOS', true),
  DOWNLOAD_ORIGINAL_LIVEPHOTOS: getEnvBool('DOWNLOAD_ORIGINAL_LIVEPHOTOS', true),
  DOWNLOAD_RETWEET_IMAGES: getEnvBool('DOWNLOAD_RETWEET_IMAGES', false),
  DOWNLOAD_RETWEET_VIDEOS: getEnvBool('DOWNLOAD_RETWEET_VIDEOS', false),
  DOWNLOAD_RETWEET_LIVEPHOTOS: getEnvBool('DOWNLOAD_RETWEET_LIVEPHOTOS', false),
  DOWNLOAD_COMMENT_MEDIA: getEnvBool('DOWNLOAD_COMMENT_MEDIA', false),
  CONCURRENT_DOWNLOADS: getEnvNum('CONCURRENT_DOWNLOADS', 10),
  
  OUTPUT_DIR: (() => {
    const raw = getEnvStr('OUTPUT_DIR');
    if (!raw) return path.join(process.cwd(), 'output');
    return path.isAbsolute(raw) ? raw : path.resolve(process.cwd(), raw);
  })(),
  SAVE_TYPES: getEnvArray('SAVE_TYPES', ['csv', 'json', 'markdown']),
  
  DB_TYPE: (() => {
    const val = getEnvStr('DB_TYPE');
    if (val === undefined) return 'sqlite';
    const trimmed = val.trim();
    return trimmed ? (trimmed.toLowerCase() as DbType) : null;
  })(),
  DB_URI: getEnvStr('DB_URI') || path.join(process.cwd(), 'weibo.sqlite'),
};
