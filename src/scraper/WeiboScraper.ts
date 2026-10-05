import * as fs from 'fs';
import * as path from 'path';
import axios from 'axios';
import * as cheerio from 'cheerio';
import { config } from '../config';
import { logger } from '../utils/logger';
import { AuthManager } from '../auth/AuthManager';
import { parsePost, parseComment, ParsedPost, ParsedComment, cleanHtmlText } from './parser';
import { StoragePipeline } from '../storage/StoragePipeline';
import { getDb } from '../storage/db';
import { resolveMid } from '../utils/base62';
import { sessionManager } from '../auth/SessionManager';
import { SessionExpiredError } from '../auth/types';
import { getAxiosProxyConfig } from '../utils/proxyHelper';

// Re-export for backward compatibility
export { SessionExpiredError };

function getTodayString(): string {
  const d = new Date();
  const beijingMs = d.getTime() + 8 * 3600 * 1000;
  const beijingDate = new Date(beijingMs);
  const pad = (n: number) => String(n).padStart(2, '0');
  const year = beijingDate.getUTCFullYear();
  const month = pad(beijingDate.getUTCMonth() + 1);
  const day = pad(beijingDate.getUTCDate());
  return `${year}-${month}-${day}`;
}

function formatToMinute(input: Date | number): string {
  const d = typeof input === 'number' ? new Date(input) : input;
  try {
    const formatter = new Intl.DateTimeFormat('zh-CN', {
      timeZone: 'Asia/Shanghai',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false
    });
    const parts = formatter.formatToParts(d);
    const getPart = (t: string) => parts.find(p => p.type === t)?.value || '';
    return `${getPart('year')}-${getPart('month')}-${getPart('day')} ${getPart('hour')}:${getPart('minute')}`;
  } catch {
    const pad = (n: number) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }
}

function getDateRange(startDate: string, endDate: string, order: 'asc' | 'desc'): string[] {
  const days: string[] = [];
  const start = new Date(startDate + 'T00:00:00');
  const end = new Date(endDate + 'T00:00:00');

  const current = new Date(start);
  while (current <= end) {
    const y = current.getFullYear();
    const m = String(current.getMonth() + 1).padStart(2, '0');
    const d = String(current.getDate()).padStart(2, '0');
    days.push(`${y}-${m}-${d}`);
    current.setDate(current.getDate() + 1);
  }

  if (order === 'desc') {
    days.reverse();
  }

  return days;
}

interface CrawlRequest {
  url: string;
  userData: {
    label: 'PROFILE_PAGE' | 'SEARCH_PAGE';
    uid: string;
    page?: number;
    cursor: number;
    effectiveEndDate?: string;
    dayDate?: string;
    actualStartDate?: string;
    isTargeted?: boolean;
  };
}

class Spinner {
  private timer: NodeJS.Timeout | null = null;
  private chars = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
  private index = 0;
  private text = '';

  constructor(text: string) {
    this.text = text;
  }

  start() {
    if (!process.stdout.isTTY) return;
    this.timer = setInterval(() => {
      const char = this.chars[this.index];
      this.index = (this.index + 1) % this.chars.length;
      process.stdout.write(`\r${char} ${this.text}`);
    }, 80);
  }

  updateText(text: string) {
    this.text = text;
    if (process.stdout.isTTY && !this.timer) {
      process.stdout.write(`\r${this.text}`);
    }
  }

  stop(finalText?: string) {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    if (process.stdout.isTTY) {
      process.stdout.write('\r\x1b[K'); // clear line
      if (finalText) {
        logger.info(finalText);
      }
    }
  }
}

export class WeiboScraper {
  private pipeline: StoragePipeline;
  private requestQueue: CrawlRequest[] = [];
  private screenNameCache = new Map<string, string>();
  private crawledPostsDayCache = new Map<string, Set<string>>();
  private activeStats = new Map<string, {
    name: string;
    postsCount: number;
    commentsCount: number;
    dateRange: string;
    errors: string[];
  }>();

  constructor() {
    this.pipeline = new StoragePipeline();
  }

  private getDayCacheKey(uid: string, dateStr: string): string {
    return `${uid}_${dateStr}`;
  }

  private markPostAsCrawled(uid: string, dateStr: string, postId: string): void {
    const key = this.getDayCacheKey(uid, dateStr);
    const existing = this.crawledPostsDayCache.get(key);
    if (existing) {
      existing.add(postId);
    }
  }

  private getBloggerName(uid: string): string {
    try {
      const { readUsers } = require('../utils/userFileHelper');
      const users = readUsers();
      const match = users.find((u: any) => u.uid === uid);
      if (match?.name) return match.name;
    } catch {}
    return '';
  }

  /**
   * Helper request builder that attaches Cookies and User-Agent,
   * delegating session persistence and validation to SessionManager.
   */
  private async makeRequest(url: string, options: any = {}): Promise<any> {
    const headers = {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'Referer': options.headers?.Referer || 'https://weibo.com/',
      'Cookie': sessionManager.getCookieHeader(url),
      ...(options.headers || {})
    };

    const response = await axios({
      url,
      ...options,
      proxy: getAxiosProxyConfig(),
      headers
    });

    // Passive session renewal: update Set-Cookie via SessionManager
    sessionManager.processResponse(response, url);

    // Verify authentication status via redirected URL or response content
    const finalUrl = response.request?.res?.responseUrl || url;
    const bodyStr = typeof response.data === 'string' ? response.data : '';
    const data = response.data;

    const isLoginRedirect = finalUrl.includes('passport.weibo.com') || finalUrl.includes('login.php');
    const is6102 = bodyStr.includes('retcode=6102');
    const isApiUnlogin = data && (data.ok === -100 || (typeof data.url === 'string' && data.url.includes('login.php')));

    if (isLoginRedirect || is6102 || isApiUnlogin) {
      const errMsg = '检测到登录会话过期或被重定向到登录页面。停止爬虫任务。';
      logger.error(errMsg);
      throw new SessionExpiredError(errMsg);
    }

    return response;
  }

  /**
   * Main entry point to launch the crawl job
   */
  async run(): Promise<string> {
    // 1. Ensure authenticated session
    await AuthManager.ensureLogin("✅ 扫码登录成功！正在开始执行爬虫任务，请稍候...");

    // Initialize database
    await this.pipeline.initialize();

    // 2. Resolve UIDs
    let uids: string[] = [];
    const list = config.USER_ID_LIST.trim();
    if (list.toLowerCase().endsWith('.txt')) {
      const filePath = this.getCursorFilePath();
      uids = this.loadUidsFromCursorFile(filePath);
    } else {
      uids = list.split(',').map(s => s.trim()).filter(Boolean);
    }

    if (uids.length === 0) {
      const errMsg = '未从配置中解析出任何微博 UID。USER_ID_LIST 为空或无效。退出运行。';
      logger.warn(errMsg);
      return errMsg;
    }

    const uidNames = uids.map(uid => {
      const name = this.getBloggerName(uid);
      return name ? `${name} (${uid})` : uid;
    });
    logger.info(`正在启动针对博主列表的抓取: ${uidNames.join(', ')}`);

    this.activeStats.clear();
    const startTime = Date.now();

    // 3. Queue target URLs
    this.requestQueue = [];

    for (const uid of uids) {
      const cursor = this.getCursorForUser(uid);
      const bloggerName = this.getBloggerName(uid) || uid;

      let startDateStr = config.START_DATE;
      let startDateTimeStr = '';
      let endDateTimeStr = '';

      const now = new Date();
      const currentNowStr = formatToMinute(now);
      const todayStr = getTodayString();
      const effectiveEndDate = config.END_DATE || todayStr;

      if (cursor > 0) {
        startDateTimeStr = formatToMinute(cursor);
        const date = new Date(cursor);
        const y = date.getFullYear();
        const m = String(date.getMonth() + 1).padStart(2, '0');
        const d = String(date.getDate()).padStart(2, '0');
        startDateStr = `${y}-${m}-${d}`;
      } else if (config.START_DATE) {
        startDateStr = config.START_DATE;
        startDateTimeStr = `${config.START_DATE} 00:00`;
      }

      if (config.END_DATE && config.END_DATE !== todayStr) {
        endDateTimeStr = `${config.END_DATE} 23:59`;
      } else {
        endDateTimeStr = currentNowStr;
      }

      let dateRangeStr = `主页 Feed 模式 (截至 ${currentNowStr})`;
      if (startDateTimeStr) {
        dateRangeStr = `${startDateTimeStr} 至 ${endDateTimeStr}`;
      }

      this.activeStats.set(uid, {
        name: bloggerName,
        postsCount: 0,
        commentsCount: 0,
        dateRange: dateRangeStr,
        errors: []
      });

      if (startDateStr) {
        const effectiveEndDate = config.END_DATE || getTodayString();
        const days = getDateRange(startDateStr, effectiveEndDate, config.DATE_ORDER);
        logger.info(`博主 ${bloggerName} (${uid}) 的日期区间模式: ${startDateStr} → ${effectiveEndDate} (${config.DATE_ORDER})，共计 ${days.length} 天进行抓取`);

        for (const dayStr of days) {
          const searchUrl = `https://s.weibo.com/weibo?q=uid:${uid}&typeall=1&suball=1&timescope=custom:${dayStr}:${dayStr}&page=1`;
          this.requestQueue.push({
            url: searchUrl,
            userData: { label: 'SEARCH_PAGE', uid, page: 1, cursor, effectiveEndDate, dayDate: dayStr, actualStartDate: startDateStr }
          });
        }
      } else {
        const profileUrl = `https://weibo.com/u/${uid}`;
        this.requestQueue.push({
          url: profileUrl,
          userData: { label: 'PROFILE_PAGE', uid, cursor }
        });
      }
    }

    // Process request queue with maxConcurrency 1
    while (this.requestQueue.length > 0) {
      const req = this.requestQueue.shift()!;
      
      let attempts = 0;
      const maxAttempts = 3;
      let success = false;
      while (!success && attempts < maxAttempts) {
        try {
          attempts++;
          const { label, uid } = req.userData;
          const bloggerName = this.getBloggerName(uid) || uid;
          const displayName = bloggerName === uid ? uid : `${bloggerName} (${uid})`;
          logger.info(`正在处理 URL: ${req.url} (页面类型: ${label}, 目标: ${displayName})`);

          if (label === 'PROFILE_PAGE') {
            await this.handleProfilePage(req.userData);
          } else if (label === 'SEARCH_PAGE') {
            await this.handleSearchPage(req.url, req.userData);
          }
          success = true;
        } catch (err: any) {
          logger.error(`请求失败 (${attempts}/${maxAttempts}): ${req.url}。错误: ${err.message || err}`);
          if (err instanceof SessionExpiredError || err.message?.includes('检测到登录会话过期')) {
            logger.error('检测到登录会话已过期，停止当前爬取队列。由上层调度统一处理重新鉴权。');
            throw err;
          }
          if (attempts >= maxAttempts) {
            logger.error(`请求已放弃: ${req.url}`);
          } else {
            await new Promise(resolve => setTimeout(resolve, 3000 * attempts));
          }
        }
      }

      // Add a slight delay between requests
      await new Promise(resolve => setTimeout(resolve, 2000 + Math.random() * 1000));
    }

    const durationSec = ((Date.now() - startTime) / 1000).toFixed(1);
    logger.info('微博爬虫增量同步运行成功！');

    return this.generateSummaryMessage(durationSec);
  }

  private generateSummaryMessage(durationSec: string): string {
    let msg = "🤖 微博爬虫增量同步运行报告\n\n";
    let totalPosts = 0;
    let totalComments = 0;
    
    for (const [uid, stats] of this.activeStats.entries()) {
      msg += `👤 博主: ${stats.name} (${uid})\n`;
      msg += `📅 区间: ${stats.dateRange}\n`;
      msg += `📥 新增微博: ${stats.postsCount} 条\n`;
      if (config.SCRAPE_COMMENTS) {
        msg += `💬 抓取评论: ${stats.commentsCount} 条\n`;
      }
      if (stats.errors.length > 0) {
        const displayErrors = stats.errors.slice(0, 3).map(e => `• ${e}`).join('\n');
        msg += `⚠️ 异常提示 (${stats.errors.length}个):\n${displayErrors}\n`;
      }
      msg += `\n`;
      totalPosts += stats.postsCount;
      totalComments += stats.commentsCount;
    }
    
    msg += `====================\n`;
    msg += `📊 运行数据统计汇总:\n`;
    msg += `👥 运行博主总数: ${this.activeStats.size} 位\n`;
    msg += `📝 累计新增微博: ${totalPosts} 条\n`;
    if (config.SCRAPE_COMMENTS) {
      msg += `💬 累计抓取评论: ${totalComments} 条\n`;
    }
    msg += `⏱️ 爬虫运行耗时: ${durationSec} 秒\n`;
    msg += `✨ 增量同步任务全部完成！`;
    
    return msg;
  }

  /**
   * Crawl a user's profile feed by calling mymblog API directly
   */
  private async handleProfilePage(userData: any): Promise<void> {
    const { uid, cursor } = userData;
    const screenName = await this.getScreenName(uid);
    const displayName = `${screenName} (${uid})`;
    logger.info(`正在抓取 ${displayName} 的主页 Feed`);

    let pageNum = 1;
    let keepCrawling = true;
    let latestPostTimestamp = 0;
    let crawlCompletedNormally = false;

    while (keepCrawling) {
      logger.info(`正在获取博主 ${screenName} (${uid}) 的第 ${pageNum} 页数据...`);
      let mymblogData: any = null;

      try {
        const response = await this.makeRequest(`https://weibo.com/ajax/statuses/mymblog?uid=${uid}&page=${pageNum}&feature=0`, {
          method: 'GET',
          headers: { 'Referer': `https://weibo.com/u/${uid}` },
          responseType: 'json'
        });
        mymblogData = response.data;
      } catch (err: any) {
        logger.error(`获取第 ${pageNum} 页 mymblog 数据失败: ${err.message}`);
        // 网络请求失败，跳出循环。由于 crawlCompletedNormally 为 false，不会推进游标，避免断点丢失
        break;
      }

      const list = mymblogData?.data?.list || [];
      if (list.length === 0) {
        logger.info(`在第 ${pageNum} 页上未发现 ${displayName} 的更多微博。`);
        crawlCompletedNormally = true;
        break;
      }

      logger.info(`成功获取到第 ${pageNum} 页的 ${list.length} 条微博。开始处理...`);

      for (const rawPost of list) {
        const parsedPost: ParsedPost = parsePost(rawPost);

        // Verify author ID
        const postAuthorId = rawPost?.user?.idstr || rawPost?.user?.id?.toString();
        if (postAuthorId && postAuthorId !== uid) {
          logger.debug(`微博 ${parsedPost.id} 的作者 ID (${postAuthorId}) 与目标 ${displayName} 不符。跳过此条。`);
          continue;
        }

        const postTime = new Date(parsedPost.time).getTime();
        const isPinned = rawPost.isTop === 1;

        if (!isPinned && postTime > latestPostTimestamp) {
          latestPostTimestamp = postTime;
        }

        // Compare against cursor for incremental sync
        if (cursor > 0 && postTime <= cursor && !isPinned) {
          logger.info(`已到达增量同步边界（微博发布时间 ${parsedPost.time} <= 游标时间 ${new Date(cursor).toISOString()}）。停止主页抓取。`);
          keepCrawling = false;
          crawlCompletedNormally = true;
          break;
        }

        // Check if post is already crawled
        const postDateStr = parsedPost.time.substring(0, 10);
        const alreadyCrawled = await this.isPostAlreadyCrawled(uid, screenName, postDateStr, parsedPost.id);
        if (alreadyCrawled) {
          logger.info(`微博 ID ${parsedPost.id} 之前已抓取过且已保存。跳过此条。`);
          continue;
        }

        // Filter original posts
        if (config.ONLY_ORIGINAL && parsedPost.is_retweet) {
          logger.debug(`跳过转发微博，ID: ${parsedPost.id}`);
          continue;
        }

        // Process long text
        if (rawPost.isLongText) {
          try {
            logger.info(`微博 ${parsedPost.id} 是长正文。正在获取完整内容...`);
            const response = await this.makeRequest(`https://weibo.com/ajax/statuses/longtext?id=${parsedPost.id}`, {
              method: 'GET',
              headers: { 'Referer': `https://weibo.com/detail/${parsedPost.id}` },
              responseType: 'json'
            });
            const longTextData = response.data;

            if (longTextData?.data?.longTextContent) {
              parsedPost.content = cleanHtmlText(longTextData.data.longTextContent);
            }
          } catch (err: any) {
            logger.error(`加载长正文微博 ${parsedPost.id} 失败: ${err.message}`);
          }
        }

        // Comments and storage pipeline process
        let comments: ParsedComment[] = [];
        try {
          if (config.SCRAPE_COMMENTS && parsedPost.comments_count > 0) {
            comments = await this.scrapeComments(parsedPost.id, uid);
          }

          // Dispatch to storage pipeline
          await this.pipeline.process(parsedPost, comments, screenName, uid);
          this.markPostAsCrawled(uid, postDateStr, parsedPost.id);

          const stats = this.activeStats.get(uid);
          if (stats) {
            stats.postsCount++;
            stats.commentsCount += comments.length;
          }
        } catch (err: any) {
          logger.error(`处理微博 ID ${parsedPost.id} 时出错: ${err.message}`);
          const stats = this.activeStats.get(uid);
          if (stats) {
            stats.errors.push(`微博 ${parsedPost.id}: ${err.message}`);
          }
        }

        // Anti-scraping delay
        await new Promise(resolve => setTimeout(resolve, 500 + Math.random() * 500));
      }

      if (keepCrawling) {
        pageNum++;
        // Short pause between page requests
        await new Promise(resolve => setTimeout(resolve, 2000 + Math.random() * 1000));
      }
    }

    // 仅当抓取正常结束（到达末尾或遇到已知游标）时才推进游标，严防因网络异常导致游标过早跳变而漏抓老微博
    if (crawlCompletedNormally) {
      let cursorTimestamp = latestPostTimestamp > 0 ? latestPostTimestamp : Date.now();
      if (config.END_DATE && config.END_DATE !== getTodayString()) {
        const endTs = Date.parse(`${config.END_DATE}T23:59:59+08:00`);
        if (!isNaN(endTs)) {
          cursorTimestamp = endTs;
        }
      }
      this.updateCursorForUser(uid, screenName, cursorTimestamp);
    } else {
      logger.warn(`博主 ${displayName} 的主页抓取因网络异常或其他错误中断，未完整执行完毕。已安全保留原有游标，下次将自动续传。`);
    }
  }

  /**
   * Crawl a s.weibo.com search page for specific date ranges
   */
  private async handleSearchPage(url: string, userData: any): Promise<void> {
    const { uid, page: currentPageNum, cursor, effectiveEndDate, dayDate, actualStartDate, isTargeted } = userData;
    const currentDay = dayDate || config.START_DATE || getTodayString();
    const bloggerName = this.getBloggerName(uid) || uid;
    const displayName = bloggerName === uid ? uid : `${bloggerName} (${uid})`;
    logger.info(`正在从 s.weibo.com 搜索结果第 ${currentPageNum} 页提取微博 ID，目标: ${displayName} (日期: ${currentDay})`);

    // Fetch search results HTML
    const searchRes = await this.makeRequest(url, {
      method: 'GET',
      responseType: 'text'
    });

    const $ = cheerio.load(searchRes.data);

    // Extract mid attributes
    const mids: string[] = $('.card-wrap[mid]')
      .map((i, el) => $(el).attr('mid'))
      .get()
      .filter(Boolean);

    logger.info(`成功从搜索页面提取出 ${mids.length} 个微博 ID。`);

    // Check if there is a next page
    const hasNextPage = $('a.next').length > 0;

    // Get user profile screen name (cached per UID)
    const screenName = await this.getScreenName(uid);

    let latestPostTimestamp = 0;

    // Fetch detail and comments for each mid
    for (const mid of mids) {
      // Check if post is already crawled
      const alreadyCrawled = await this.isPostAlreadyCrawled(uid, screenName, currentDay, mid);
      if (alreadyCrawled) {
        logger.info(`微博 ID ${mid} 之前已抓取过且已保存。跳过此条。`);
        continue;
      }

      logger.info(`正在使用 ajax/statuses/show 获取微博 ${mid} 的详情...`);
      try {
        const response = await this.makeRequest(`https://weibo.com/ajax/statuses/show?id=${mid}`, {
          method: 'GET',
          headers: { 'Referer': `https://weibo.com/detail/${mid}` },
          responseType: 'json'
        });
        const postData = response.data;

        if (!postData) continue;

        const parsedPost: ParsedPost = parsePost(postData);

        // Verify author ID
        const postAuthorId = postData?.user?.idstr || postData?.user?.id?.toString();
        if (postAuthorId && postAuthorId !== uid) {
          logger.info(`微博 ${parsedPost.id} 的作者 ID (${postAuthorId}) 与目标 ${displayName} 不符（搜索结果推荐内容）。跳过此条。`);
          continue;
        }

        const postTime = new Date(parsedPost.time).getTime();

        // Verify date ranges
        const targetStartDate = actualStartDate || config.START_DATE;
        if (targetStartDate) {
          const overallEndDate = effectiveEndDate || config.END_DATE || getTodayString();
          const startMs = new Date(`${targetStartDate}T00:00:00+08:00`).getTime();
          const endMs = new Date(`${overallEndDate}T23:59:59+08:00`).getTime();
          if (postTime < startMs || postTime > endMs) {
            logger.info(`微博 ${parsedPost.id} 的发布时间 (${parsedPost.time}) 超出了设定区间 [${targetStartDate}, ${overallEndDate}]。跳过此条。`);
            continue;
          }
        }

        if (postTime > latestPostTimestamp) {
          latestPostTimestamp = postTime;
        }

        // Filter original posts
        if (config.ONLY_ORIGINAL && parsedPost.is_retweet) {
          logger.info(`微博 ${parsedPost.id} 为转发微博，根据 ONLY_ORIGINAL=true 配置已跳过。`);
          continue;
        }

        // Fetch long text if needed
        if (postData.isLongText) {
          try {
            const response = await this.makeRequest(`https://weibo.com/ajax/statuses/longtext?id=${parsedPost.id}`, {
              method: 'GET',
              headers: { 'Referer': `https://weibo.com/detail/${parsedPost.id}` },
              responseType: 'json'
            });
            const longTextData = response.data;
            if (longTextData?.data?.longTextContent) {
              parsedPost.content = cleanHtmlText(longTextData.data.longTextContent);
            }
          } catch (err: any) {
            logger.error(`在搜索页加载长正文微博 ${parsedPost.id} 失败: ${err.message}`);
          }
        }

        // Fetch comments
        let comments: ParsedComment[] = [];
        if (config.SCRAPE_COMMENTS && parsedPost.comments_count > 0) {
          comments = await this.scrapeComments(parsedPost.id, uid);
        }

        // Dispatch to storage
        await this.pipeline.process(parsedPost, comments, screenName, uid);
        this.markPostAsCrawled(uid, currentDay, parsedPost.id);

        const stats = this.activeStats.get(uid);
        if (stats) {
          stats.postsCount++;
          stats.commentsCount += comments.length;
        }

        // Standard delay
        await new Promise(resolve => setTimeout(resolve, 500 + Math.random() * 500));
      } catch (err: any) {
        logger.error(`处理微博 ID ${mid} 时出错: ${err.message}`);
        const stats = this.activeStats.get(uid);
        if (stats) {
          stats.errors.push(`微博 ${mid}: ${err.message}`);
        }
      }
    }

    // Check if there is a next page
    if (hasNextPage) {
      const nextPageNum = currentPageNum + 1;
      const nextUrl = `https://s.weibo.com/weibo?q=uid:${uid}&typeall=1&suball=1&timescope=custom:${currentDay}:${currentDay}&page=${nextPageNum}`;

      this.requestQueue.unshift({
        url: nextUrl,
        userData: { label: 'SEARCH_PAGE', uid, page: nextPageNum, cursor, effectiveEndDate, dayDate: currentDay, actualStartDate, isTargeted }
      });
      logger.info(`已将下一页搜索页（第 ${nextPageNum} 页）加入队列优先处理，针对日期 ${currentDay}`);
    } else {
      logger.info(`已完成日期 ${currentDay} 的所有搜索页爬取。`);
      if (!isTargeted) {
        let cursorTimestamp = Date.now();
        if (config.END_DATE && currentDay === config.END_DATE) {
          if (config.END_DATE !== getTodayString()) {
            const endTs = Date.parse(`${config.END_DATE}T23:59:59+08:00`);
            if (!isNaN(endTs)) {
              cursorTimestamp = endTs;
            }
          }
        } else if (currentDay !== getTodayString()) {
          const dayEndTs = Date.parse(`${currentDay}T23:59:59+08:00`);
          if (!isNaN(dayEndTs)) {
            cursorTimestamp = dayEndTs;
          }
        }
        this.updateCursorForUser(uid, screenName, cursorTimestamp);
      } else {
        logger.info(`已跳过 ${displayName} 的游标文件更新，因为这是定向运行任务。`);
      }
    }
  }

  /**
   * Scrapes comments for a post, including sub-comments
   */
  private async scrapeComments(postId: string, uid: string): Promise<ParsedComment[]> {
    const parsedComments: ParsedComment[] = [];
    const seenCommentIds = new Set<string>();
    const limit = config.MAX_COMMENTS_PER_POST <= 0 ? Infinity : config.MAX_COMMENTS_PER_POST;

    const spinner = new Spinner(`正在获取微博 ID: ${postId} 的评论列表: 已获取 0 条...`);
    if (process.stdout.isTTY) {
      spinner.start();
    } else {
      logger.info(`正在获取微博 ID: ${postId} 的评论列表...`);
    }

    // Determine flow sequence: if default COMMENT_FLOW is 0 (按热度), we first fetch hot comments,
    // and if limit is not reached, optionally fall back to flow=1 (按时间) to capture any additional timeline comments.
    const flowsToTry: number[] = [];
    if (config.COMMENT_FLOW === 0) {
      flowsToTry.push(0); // Hot comments first (much more comments for stars/hot posts)
      flowsToTry.push(1); // Timeline comments fallback
    } else {
      flowsToTry.push(1); // Explicit timeline comments
    }

    for (const currentFlow of flowsToTry) {
      if (parsedComments.length >= limit) break;

      let maxId = '0';
      let keepFetching = true;

      while (keepFetching && parsedComments.length < limit) {
        let commentsData: any = null;
        try {
          const url = `https://weibo.com/ajax/statuses/buildComments?flow=${currentFlow}&is_reload=1&id=${postId}&is_show_bulletin=2&is_mix=0&count=20&uid=${uid}${maxId !== '0' ? `&max_id=${maxId}` : ''}`;
          const response = await this.makeRequest(url, {
            method: 'GET',
            headers: { 'Referer': `https://weibo.com/detail/${postId}` },
            responseType: 'json'
          });
          commentsData = response.data;
        } catch (err: any) {
          spinner.stop();
          logger.error(`获取微博 ${postId} 的评论失败 (flow=${currentFlow}): ${err.message}`);
          break;
        }

        const data = commentsData?.data || [];
        if (data.length === 0) {
          break;
        }

        for (const rawComment of data) {
          const parsedComment = parseComment(rawComment, postId);
          if (!seenCommentIds.has(parsedComment.id)) {
            seenCommentIds.add(parsedComment.id);
            parsedComments.push(parsedComment);
          }

          const rawReplies = rawComment.comments || [];
          for (const rawReply of rawReplies) {
            const parsedReply = parseComment(rawReply, postId, parsedComment.id);
            if (!seenCommentIds.has(parsedReply.id)) {
              seenCommentIds.add(parsedReply.id);
              parsedComments.push(parsedReply);
            }
          }

          const totalNumber = rawComment.total_number || 0;
          if (totalNumber > rawReplies.length && parsedComments.length < limit) {
            spinner.updateText(`正在获取微博 ID: ${postId} 的评论列表: 已获取 ${parsedComments.length} 条 (正在补充楼中楼回复)...`);
            const maxSubForThisComment = Math.min(
              config.MAX_SUB_COMMENTS_PER_COMMENT <= 0 ? 100 : config.MAX_SUB_COMMENTS_PER_COMMENT,
              limit === Infinity ? 100 : Math.max(1, limit - parsedComments.length)
            );
            const fetchedReplies = await this.scrapeSubComments(postId, parsedComment.id, uid, maxSubForThisComment);
            for (const reply of fetchedReplies) {
              if (!seenCommentIds.has(reply.id)) {
                seenCommentIds.add(reply.id);
                parsedComments.push(reply);
              }
              if (parsedComments.length >= limit) break;
            }
          }

          if (parsedComments.length >= limit) {
            break;
          }
        }

        spinner.updateText(`正在获取微博 ID: ${postId} 的评论列表: 已获取 ${parsedComments.length} 条...`);

        maxId = commentsData?.max_id?.toString() || '0';
        if (maxId === '0' || maxId === '' || commentsData?.trendsText === '已加载全部评论') {
          keepFetching = false;
        } else {
          await new Promise(resolve => setTimeout(resolve, config.REQUEST_DELAY_MIN + Math.random() * (config.REQUEST_DELAY_MAX - config.REQUEST_DELAY_MIN)));
        }
      }
    }

    const finalCount = Math.min(parsedComments.length, limit);
    if (process.stdout.isTTY) {
      spinner.stop(`成功获取到微博 ${postId} 的 ${finalCount} 条评论`);
    } else {
      logger.info(`成功获取到微博 ${postId} 的 ${finalCount} 条评论`);
    }
    return parsedComments.slice(0, limit);
  }

  /**
   * Scrapes sub-comments
   */
  private async scrapeSubComments(postId: string, parentCommentId: string, uid: string, maxSub = 50): Promise<ParsedComment[]> {
    const subComments: ParsedComment[] = [];
    let maxId = '0';
    let keepFetching = true;

    while (keepFetching && subComments.length < maxSub) {
      let subCommentsData: any = null;
      try {
        const url = `https://weibo.com/ajax/statuses/buildComments?flow=1&is_reload=1&id=${parentCommentId}&is_show_bulletin=2&is_mix=1&fetch_level=1&count=20&uid=${uid}${maxId !== '0' ? `&max_id=${maxId}` : ''}`;
        const response = await this.makeRequest(url, {
          method: 'GET',
          headers: { 'Referer': `https://weibo.com/detail/${postId}` },
          responseType: 'json'
        });
        subCommentsData = response.data;
      } catch (err: any) {
        logger.warn(`获取主评论 ${parentCommentId} 的子评论（楼中楼）失败: ${err.message}`);
        break;
      }

      const data = subCommentsData?.data || [];
      if (data.length === 0) break;

      for (const rawSubComment of data) {
        subComments.push(parseComment(rawSubComment, postId, parentCommentId));
        if (subComments.length >= maxSub) break;
      }

      maxId = subCommentsData?.max_id?.toString() || '0';
      if (maxId === '0' || maxId === '' || subCommentsData?.trendsText === '已加载全部评论') {
        keepFetching = false;
      } else {
        await new Promise(resolve => setTimeout(resolve, config.REQUEST_DELAY_MIN + Math.random() * (config.REQUEST_DELAY_MAX - config.REQUEST_DELAY_MIN)));
      }
    }

    return subComments;
  }

  /**
   * Helper to check if a post has already been crawled (with in-memory day caching)
   */
  private async isPostAlreadyCrawled(uid: string, screenName: string, dateStr: string, postId: string): Promise<boolean> {
    const cacheKey = this.getDayCacheKey(uid, dateStr);
    let daySet = this.crawledPostsDayCache.get(cacheKey);

    if (!daySet) {
      // LRU safeguard: if cache exceeds 300 days, evict the oldest key
      if (this.crawledPostsDayCache.size > 300) {
        const firstKey = this.crawledPostsDayCache.keys().next().value;
        if (firstKey) this.crawledPostsDayCache.delete(firstKey);
      }

      daySet = new Set<string>();
      this.crawledPostsDayCache.set(cacheKey, daySet);

      const sanitizedScreenName = screenName.replace(/[\\/:*?"<>|]/g, '_').trim();
      const monthSubDir = dateStr.substring(0, 7);

      if (config.SAVE_TYPES.includes('json')) {
        const jsonPath = path.join(config.OUTPUT_DIR, sanitizedScreenName, monthSubDir, 'json', `${dateStr}.json`);
        if (fs.existsSync(jsonPath)) {
          try {
            const content = fs.readFileSync(jsonPath, 'utf8');
            const parsed = JSON.parse(content);
            if (Array.isArray(parsed)) {
              for (const item of parsed) {
                if (item?.post?.id) {
                  daySet.add(item.post.id);
                }
              }
            }
          } catch (e) {}
        }
      }

      if (config.SAVE_TYPES.includes('markdown')) {
        const mdPath = path.join(config.OUTPUT_DIR, sanitizedScreenName, monthSubDir, `${dateStr}.md`);
        if (fs.existsSync(mdPath)) {
          try {
            const mdContent = fs.readFileSync(mdPath, 'utf8');
            const regex = /<!-- post-id: (\d+) -->/g;
            let match: RegExpExecArray | null;
            while ((match = regex.exec(mdContent)) !== null) {
              daySet.add(match[1]);
            }
          } catch (e) {}
        }
      }
    }

    if (daySet.has(postId)) {
      return true;
    }

    if (config.DB_TYPE) {
      try {
        const db = getDb();
        const exists = await db('posts').where({ id: postId }).first();
        if (exists) {
          daySet.add(postId);
          return true;
        }
      } catch (e) {}
    }

    return false;
  }

  // --- Cursor Management (Incremental Sync) ---

  private getCursorFilePath(): string {
    const list = config.USER_ID_LIST.trim();
    if (list.toLowerCase().endsWith('.txt')) {
      return path.isAbsolute(list) ? list : path.join(process.cwd(), list);
    }
    return path.join(process.cwd(), 'userid.txt');
  }

  private loadUidsFromCursorFile(filePath: string): string[] {
    if (!fs.existsSync(filePath)) {
      return [];
    }
    try {
      const content = fs.readFileSync(filePath, 'utf8');
      return content.split('\n')
        .map(line => line.trim())
        .filter(line => line && !line.startsWith('#'))
        .map(line => line.split('|')[0].trim());
    } catch (err) {
      logger.error(`Failed to read cursor file: ${filePath}`, err);
      return [];
    }
  }

  private getCursorForUser(uid: string): number {
    const filePath = this.getCursorFilePath();
    if (!fs.existsSync(filePath)) {
      return 0;
    }
    try {
      const content = fs.readFileSync(filePath, 'utf8');
      const lines = content.split('\n');
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) continue;
        const parts = trimmed.split('|');
        if (parts[0].trim() === uid) {
          const tsStr = parts[2]?.trim();
          if (tsStr) {
            const ts = /^\d+$/.test(tsStr) ? parseInt(tsStr, 10) : Date.parse(tsStr);
            return isNaN(ts) ? 0 : ts;
          }
        }
      }
    } catch (err) {
      logger.error(`Error reading cursor for UID ${uid}`, err);
    }
    return 0;
  }

  private updateCursorForUser(uid: string, name: string, timestamp: number): void {
    try {
      const currentCursor = this.getCursorForUser(uid);
      if (currentCursor > 0 && timestamp <= currentCursor) {
        logger.info(`跳过游标更新: 新时间戳 (${timestamp}) 小于或等于现有游标 (${currentCursor})，防止游标倒退。`);
        return;
      }

      const formatLocalISOString = (ts: number): string => {
        const date = new Date(ts);
        const pad = (n: number) => String(n).padStart(2, '0');
        const year = date.getFullYear();
        const month = pad(date.getMonth() + 1);
        const day = pad(date.getDate());
        const hours = pad(date.getHours());
        const minutes = pad(date.getMinutes());
        const seconds = pad(date.getSeconds());
        return `${year}-${month}-${day}T${hours}:${minutes}:${seconds}`;
      };

      const dateStr = formatLocalISOString(timestamp);
      const filePath = this.getCursorFilePath();
      let content = '';
      if (fs.existsSync(filePath)) {
        content = fs.readFileSync(filePath, 'utf8');
      }

      const lines = content.split('\n');
      let found = false;
      const updatedLines = lines.map(line => {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) return line;
        const parts = trimmed.split('|');
        if (parts[0].trim() === uid) {
          found = true;
          return `${uid} | ${name} | ${dateStr}`;
        }
        return line;
      });

      if (!found) {
        updatedLines.push(`${uid} | ${name} | ${dateStr}`);
      }

      fs.writeFileSync(filePath, updatedLines.join('\n'), 'utf8');
      logger.info(`Updated cursor file for ${name} (${uid}) to date ${dateStr} (timestamp: ${timestamp})`);
    } catch (err) {
      logger.error(`Failed to update cursor for UID ${uid}`, err);
    }
  }

  private saveBloggerNameToUserFile(uid: string, name: string): void {
    try {
      const filePath = this.getCursorFilePath();
      if (!fs.existsSync(filePath)) return;
      const content = fs.readFileSync(filePath, 'utf8');
      const lines = content.split('\n');
      const updatedLines = lines.map(line => {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) return line;
        const parts = trimmed.split('|');
        if (parts[0].trim() === uid) {
          const cursor = parts[2]?.trim() || '';
          return cursor ? `${uid} | ${name} | ${cursor}` : `${uid} | ${name}`;
        }
        return line;
      });
      fs.writeFileSync(filePath, updatedLines.join('\n'), 'utf8');
      logger.info(`已成功将博主 ${name} (${uid}) 的昵称持久化保存至 ${filePath}`);
    } catch (err) {
      logger.error(`保存博主昵称至用户文件失败:`, err);
    }
  }

  private async getScreenName(uid: string): Promise<string> {
    if (this.screenNameCache.has(uid)) {
      return this.screenNameCache.get(uid)!;
    }

    // 1. 如果本地 userid.txt 中已经配置了博主昵称，直接使用，不再发送任何网络请求
    const knownName = this.getBloggerName(uid);
    if (knownName) {
      this.screenNameCache.set(uid, knownName);
      return knownName;
    }

    // 2. 只有当本地没有昵称记录（如首次仅填写了 UID）时，才在线请求一次接口
    try {
      logger.info(`博主 UID ${uid} 本地无昵称记录，正在初次从微博接口获取昵称...`);
      const response = await this.makeRequest(`https://weibo.com/ajax/profile/info?uid=${uid}`, {
        method: 'GET',
        headers: { 'Referer': `https://weibo.com/u/${uid}` },
        responseType: 'json'
      });
      const profileInfo = response.data;
      if (profileInfo?.data?.user?.screen_name) {
        const name = profileInfo.data.user.screen_name;
        this.screenNameCache.set(uid, name);
        // 回写到 userid.txt 文件，后续所有爬取直接读取文件，永久无需再次请求网络
        this.saveBloggerNameToUserFile(uid, name);
        return name;
      }
    } catch (err) {
      logger.warn(`获取博主 UID (${uid}) 的详情失败，将使用默认标识继续运行。`, err);
    }

    const fallback = `user_${uid}`;
    this.screenNameCache.set(uid, fallback);
    return fallback;
  }

  /**
   * Crawl a single Weibo post directly by url, BID, or MID
   */
  async crawlSinglePost(urlOrIdOrBid: string): Promise<{ success: boolean; message: string }> {
    let rawId = "";
    if (urlOrIdOrBid.includes("/") || urlOrIdOrBid.includes("\\")) {
      const parts = urlOrIdOrBid.trim().split(/[/\\]/);
      const last = parts.filter(Boolean).pop() || "";
      rawId = last.split(/[?#]/)[0];
    } else {
      rawId = urlOrIdOrBid.trim().split(/[?#]/)[0];
    }

    let mid = "";
    try {
      mid = resolveMid(urlOrIdOrBid);
    } catch (err: any) {
      if (rawId) {
        mid = rawId;
      } else {
        return { success: false, message: `Invalid input: ${err.message}` };
      }
    }

    logger.info(`Starting targeted crawl for post: ${rawId} (resolved MID: ${mid})...`);

    // Ensure session is active
    await AuthManager.ensureLogin("✅ 扫码登录成功！正在开始抓取单条微博，请稍候...");

    // Initialize pipeline
    await this.pipeline.initialize();

    try {
      // Fetch post JSON data: try rawId and resolved mid with fallback
      logger.info(`正在获取微博 ${rawId || mid} 数据...`);
      let postData: any = null;
      const idsToTry = Array.from(new Set([rawId, mid].filter(Boolean)));
      let lastFetchErr: any = null;

      for (const targetId of idsToTry) {
        try {
          const response = await this.makeRequest(`https://weibo.com/ajax/statuses/show?id=${targetId}`, {
            method: 'GET',
            headers: { 'Referer': `https://weibo.com/detail/${targetId}` },
            responseType: 'json'
          });
          if (response?.data && (response.data.id || response.data.idstr || response.data.mid)) {
            postData = response.data;
            break;
          }
        } catch (fetchErr: any) {
          lastFetchErr = fetchErr;
        }
      }

      if (!postData) {
        throw new Error(lastFetchErr ? `API request failed: ${lastFetchErr.message}` : "API returned empty post response");
      }

      // Update mid to official authorative ID from response
      mid = postData.idstr || postData.mid || mid;

      const parsedPost: ParsedPost = parsePost(postData);

      // Resolve author information
      const uid = postData?.user?.idstr || postData?.user?.id?.toString() || "";
      const screenName = postData?.user?.screen_name || `user_${uid}`;

      if (!uid) {
        throw new Error("Unable to resolve post author UID from API response.");
      }

      logger.info(`已解析作者: ${screenName} (UID: ${uid})`);

      // Fetch long text if flag is set
      if (postData.isLongText) {
        try {
          logger.info(`微博 ${parsedPost.id} 为长微博，正在获取全文...`);
          const ltResponse = await this.makeRequest(`https://weibo.com/ajax/statuses/longtext?id=${parsedPost.id}`, {
            method: 'GET',
            headers: { 'Referer': `https://weibo.com/detail/${parsedPost.id}` },
            responseType: 'json'
          });
          const longTextData = ltResponse.data;
          if (longTextData?.data?.longTextContent) {
            parsedPost.content = cleanHtmlText(longTextData.data.longTextContent);
          }
        } catch (ltErr: any) {
          logger.error(`加载单条微博 ${parsedPost.id} 的长正文失败: ${ltErr.message}`);
        }
      }

      // Fetch comments if configured
      let comments: ParsedComment[] = [];
      if (config.SCRAPE_COMMENTS && parsedPost.comments_count > 0) {
        comments = await this.scrapeComments(parsedPost.id, uid);
      }

      // Run storage pipeline to download media and write files
      await this.pipeline.process(parsedPost, comments, screenName, uid);
      const postDateStr = parsedPost.time.substring(0, 10);
      this.markPostAsCrawled(uid, postDateStr, parsedPost.id);

      return {
        success: true,
        message: `成功抓取微博 ${mid} (博主 ${screenName})，共计 ${comments.length} 条评论。`
      };
    } catch (err: any) {
      logger.error(`定向微博 ${mid} 抓取失败:`, err);
      return { success: false, message: `抓取微博失败: ${err.message || err}` };
    }
  }

  /**
   * Crawl all posts of a specific date for a specific UID
   */
  async crawlDateForUser(uid: string, dateStr: string): Promise<{ success: boolean; message: string }> {
    const bloggerName = this.getBloggerName(uid) || uid;
    const displayName = bloggerName === uid ? uid : `${bloggerName} (${uid})`;
    logger.info(`正在对 ${displayName} 在日期 ${dateStr} 启动定向爬取...`);

    // Ensure session is active
    await AuthManager.ensureLogin("✅ 扫码登录成功！正在开始抓取指定日期数据，请稍候...");

    // Initialize pipeline
    await this.pipeline.initialize();

    const searchUrl = `https://s.weibo.com/weibo?q=uid:${uid}&typeall=1&suball=1&timescope=custom:${dateStr}:${dateStr}&page=1`;
    
    try {
      this.requestQueue = [{
        url: searchUrl,
        userData: {
          label: 'SEARCH_PAGE',
          uid,
          page: 1,
          cursor: 0,
          effectiveEndDate: dateStr,
          dayDate: dateStr,
          actualStartDate: dateStr,
          isTargeted: true
        }
      }];

      while (this.requestQueue.length > 0) {
        const req = this.requestQueue.shift()!;
        await this.handleSearchPage(req.url, req.userData);
        if (this.requestQueue.length > 0) {
          await new Promise(resolve => setTimeout(resolve, 2000 + Math.random() * 1000));
        }
      }
      
      return { success: true, message: `成功完成对 ${displayName} 在日期 ${dateStr} 的定向爬取。` };
    } catch (err: any) {
      logger.error(`定向日期爬取失败:`, err);
      return { success: false, message: `定向爬取日期数据失败: ${err.message || err}` };
    }
  }
}
