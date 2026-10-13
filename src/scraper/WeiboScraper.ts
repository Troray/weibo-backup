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
import { 
  readUsers, 
  writeUsers, 
  getUserFilePath, 
  isUserListFile, 
  getActiveUids,
  getBeijingDateParts, 
  getTodayString, 
  formatToMinute, 
  parseCursorToTimestamp 
} from '../utils/userFileHelper';
import { executePostScript, formatHookSummaryForReport, HookContext } from '../utils/postScriptRunner';
import { escapeHtml } from '../utils/htmlHelper';
import { BloggerProfileManager } from './BloggerProfileManager';
import { CommentCheckpointManager } from './CommentCheckpointManager';

// Re-export for backward compatibility
export { SessionExpiredError };

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

  private lastLogTime = 0;

  updateText(text: string) {
    this.text = text;
    if (process.stdout.isTTY) {
      if (!this.timer) {
        process.stdout.write(`\r${this.text}`);
      }
    } else {
      const now = Date.now();
      if (now - this.lastLogTime >= 5000) {
        this.lastLogTime = now;
        logger.info(this.text);
      }
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

export interface CrawlPostSummary {
  id: string;
  bid?: string;
  time: string;
  snippet: string;
  commentsCount: number;
  mediaCount: number;
  isRetweet: boolean;
}

export interface CrawlStatsEntry {
  name: string;
  postsCount: number;
  originalCount: number;
  retweetCount: number;
  commentsCount: number;
  rootCommentsCount: number;
  subCommentsCount: number;
  imagesCount: number;
  videosCount: number;
  livePhotosCount: number;
  audiosCount: number;
  dateRange: string;
  errors: string[];
  postSummaries: CrawlPostSummary[];
}

export class WeiboScraper {
  private pipeline: StoragePipeline;
  private requestQueue: CrawlRequest[] = [];
  private screenNameCache = new Map<string, string>();
  private crawledPostsDayCache = new Map<string, Set<string>>();
  private activeStats = new Map<string, CrawlStatsEntry>();
  private isAborted: boolean = false;

  public requestAbort(): void {
    this.isAborted = true;
  }

  public isAborting(): boolean {
    return this.isAborted;
  }

  constructor() {
    this.pipeline = new StoragePipeline();
  }

  private updatePostStats(uid: string, post: ParsedPost, comments: ParsedComment[]): void {
    const stats = this.activeStats.get(uid);
    if (!stats) return;

    stats.postsCount++;
    if (post.is_retweet) {
      stats.retweetCount++;
    } else {
      stats.originalCount++;
    }

    stats.commentsCount += comments.length;
    stats.rootCommentsCount += comments.filter(c => !c.parent_id).length;
    stats.subCommentsCount += comments.filter(c => !!c.parent_id).length;

    const imgCount = post.local_images?.length || 0;
    const vidCount = post.local_videos?.length || 0;
    const liveCount = post.local_livephotos?.length || 0;
    const audCount = post.local_audios?.length || 0;

    stats.imagesCount += imgCount;
    stats.videosCount += vidCount;
    stats.livePhotosCount += liveCount;
    stats.audiosCount += audCount;

    const snippet = post.content ? post.content.replace(/\s+/g, ' ').trim().slice(0, 50) : '';
    const bid = post.raw?.mblogid || post.raw?.bid || post.id;
    stats.postSummaries.push({
      id: post.id,
      bid,
      time: this.formatPostTimeShort(post.time),
      snippet,
      commentsCount: comments.length,
      mediaCount: imgCount + vidCount + liveCount + audCount,
      isRetweet: !!post.is_retweet
    });
  }

  private formatPostTimeShort(timeStr: string): string {
    if (!timeStr) return '';
    const match = timeStr.match(/(?:^\d{4}-)?(\d{2}-\d{2})[T\s](\d{2}:\d{2})/);
    if (match) {
      return `${match[1]} ${match[2]}`;
    }
    const timeOnly = timeStr.match(/(?:T|\s)(\d{2}:\d{2})/);
    if (timeOnly) return timeOnly[1];
    return timeStr.slice(0, 10);
  }

  private formatDuration(durationMs: number): string {
    const sec = (durationMs / 1000).toFixed(1);
    if (durationMs < 60000) {
      return `${sec} 秒`;
    }
    const mins = Math.floor(durationMs / 60000);
    const remainSec = Math.round((durationMs % 60000) / 1000);
    return `${mins} 分 ${remainSec} 秒 (${sec}s)`;
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
    if (!isUserListFile()) return '';
    try {
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
  async run(triggerSource: 'CLI' | 'TG_BOT' | 'SCHEDULE' = 'CLI'): Promise<string> {
    // 1. Ensure authenticated session
    await AuthManager.ensureLogin("✅ 扫码登录成功！正在开始执行爬虫任务，请稍候...");

    // Initialize database
    await this.pipeline.initialize();

    // 2. Resolve UIDs
    const uids = getActiveUids();

    if (uids.length === 0) {
      const errMsg = '未从配置中解析出任何微博 UID。USER_ID_LIST 为空或无效。退出运行。';
      logger.warn(errMsg);
      return errMsg;
    }

    this.activeStats.clear();
    const startTime = Date.now();

    try {
      // 3. Queue target URLs
      this.requestQueue = [];

      const allUsers = isUserListFile() ? readUsers() : [];

      for (const uid of uids) {
        const userEntry = allUsers.find((u: any) => u.uid === uid && !u.isCommented);
        // 自动同步并归档博主详细资料（<UID>.txt 及 profile/ 头像与背景图片）
        const profile = await BloggerProfileManager.getInstance().ensureBloggerProfile(uid, userEntry?.name);
        const cursor = this.getCursorForUser(uid);
        const bloggerName = profile?.screenName || (await this.getScreenName(uid)) || uid;

        let startDateStr = config.START_DATE;
        let startDateTimeStr = '';
        let endDateTimeStr = '';

        const now = new Date();
        const currentNowStr = formatToMinute(now);
        const todayStr = getTodayString();
        const userEndDate = userEntry?.endDate;
        const effectiveEndDate = userEndDate || config.END_DATE || todayStr;

        if (cursor > 0) {
          const bp = getBeijingDateParts(cursor);
          startDateTimeStr = bp.minuteStr;
          startDateStr = bp.dateStr;
        } else if (config.START_DATE) {
          startDateStr = config.START_DATE;
          startDateTimeStr = `${config.START_DATE} 00:00`;
        }

        const configuredEndDate = userEndDate || config.END_DATE;
        if (configuredEndDate && configuredEndDate !== todayStr) {
          endDateTimeStr = `${configuredEndDate} 23:59`;
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
          originalCount: 0,
          retweetCount: 0,
          commentsCount: 0,
          rootCommentsCount: 0,
          subCommentsCount: 0,
          imagesCount: 0,
          videosCount: 0,
          livePhotosCount: 0,
          audiosCount: 0,
          dateRange: dateRangeStr,
          errors: [],
          postSummaries: []
        });

        if (startDateStr) {
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
            userData: { label: 'PROFILE_PAGE', uid, cursor, effectiveEndDate }
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

      let summary = this.generateSummaryMessage(durationSec);

      let totalPosts = 0;
      let totalMedia = 0;
      let totalComments = 0;
      const targetUsers: string[] = [];
      for (const [uid, stats] of this.activeStats.entries()) {
        targetUsers.push(uid);
        totalPosts += stats.postsCount;
        totalComments += stats.commentsCount;
        totalMedia += (stats.imagesCount + stats.videosCount + stats.livePhotosCount + stats.audiosCount);
      }

      const hookContext: HookContext = {
        status: 'SUCCESS',
        taskType: 'INCREMENTAL',
        triggerSource,
        postsCount: totalPosts,
        mediaCount: totalMedia,
        commentsCount: totalComments,
        targetUsers,
        durationSec: parseFloat(durationSec),
        summaryText: summary
      };

      const hookResult = await executePostScript(hookContext);
      if (hookResult.executed) {
        summary += formatHookSummaryForReport(hookResult);
      }

      return summary;
    } catch (err: any) {
      let totalPosts = 0;
      let totalMedia = 0;
      let totalComments = 0;
      const targetUsers: string[] = [];
      for (const [uid, stats] of this.activeStats.entries()) {
        targetUsers.push(uid);
        totalPosts += stats.postsCount;
        totalComments += stats.commentsCount;
        totalMedia += (stats.imagesCount + stats.videosCount + stats.livePhotosCount + stats.audiosCount);
      }

      const isSessionExpired = err instanceof SessionExpiredError || err.message?.includes('检测到登录会话过期');
      const hookContext: HookContext = {
        status: isSessionExpired ? 'SESSION_EXPIRED' : 'FAILED',
        taskType: 'INCREMENTAL',
        triggerSource,
        postsCount: totalPosts,
        mediaCount: totalMedia,
        commentsCount: totalComments,
        targetUsers,
        durationSec: parseFloat(((Date.now() - startTime) / 1000).toFixed(1)),
        summaryText: err.message || String(err)
      };

      const hookResult = await executePostScript(hookContext);
      if (hookResult.executed) {
        if (typeof err === 'object' && err !== null) {
          err.message = `${err.message || String(err)}\n${formatHookSummaryForReport(hookResult)}`;
        } else {
          err = new Error(`${err}\n${formatHookSummaryForReport(hookResult)}`);
        }
      }
      throw err;
    }
  }

  private generateSummaryMessage(durationSec: string): string {
    let msg = "🤖 <b>【微博爬虫增量同步运行报告】</b>\n\n";
    let totalPosts = 0;
    let totalOriginal = 0;
    let totalRetweet = 0;
    let totalComments = 0;
    let totalRootComments = 0;
    let totalSubComments = 0;
    let totalMedia = 0;
    
    for (const [uid, stats] of this.activeStats.entries()) {
      const realName = this.screenNameCache.get(uid) || this.getBloggerName(uid) || stats.name;
      const displayName = (realName && realName !== uid && !realName.startsWith('user_'))
        ? `${realName} (${uid})`
        : uid;
      msg += `👤 <b>博主: ${escapeHtml(displayName)}</b>\n`;
      msg += `📅 区间: ${escapeHtml(stats.dateRange)}\n`;
      msg += `📥 新增微博: ${stats.postsCount} 条 (原创: ${stats.originalCount} | 转发: ${stats.retweetCount})\n`;
      if (config.SCRAPE_COMMENTS) {
        msg += `💬 抓取评论: ${stats.commentsCount} 条 (一级主评: ${stats.rootCommentsCount} | 二级楼中楼: ${stats.subCommentsCount})\n`;
      }
      const bloggerMedia = stats.imagesCount + stats.videosCount + stats.livePhotosCount + stats.audiosCount;
      if (bloggerMedia > 0) {
        msg += `🖼️ 媒体下载: ${bloggerMedia} 项 (图: ${stats.imagesCount} | 视: ${stats.videosCount} | 实况: ${stats.livePhotosCount} | 音: ${stats.audiosCount})\n`;
      }
      if (stats.postSummaries && stats.postSummaries.length > 0) {
        const maxDisplay = this.activeStats.size > 5 ? 5 : 10;
        const displayList = stats.postSummaries.slice(0, maxDisplay);
        const remainingCount = stats.postSummaries.length - displayList.length;

        msg += `<blockquote expandable>\n`;
        msg += `📋 <b>新增博文清单 (共 ${stats.postSummaries.length} 条):</b>\n`;
        for (const p of displayList) {
          const typeTag = p.isRetweet ? '[转]' : '[原]';
          const postUrl = `https://weibo.com/${uid}/${p.bid || p.id}`;
          const cleanText = p.snippet ? p.snippet.replace(/\.+$/, '').trim() : '';
          const snippetStr = cleanText ? `: ${escapeHtml(cleanText.length > 42 ? cleanText.slice(0, 42) + '...' : cleanText)}` : '';
          const mediaStr = p.mediaCount > 0 ? ` | 媒 ${p.mediaCount}` : '';
          msg += `• ${escapeHtml(p.time)} <a href="${postUrl}">${typeTag}</a> (评 ${p.commentsCount}${mediaStr})${snippetStr}\n`;
        }

        if (remainingCount > 0) {
          msg += `\n... 其余 ${remainingCount} 条博文已完整入库\n`;
        }
        const folderRelPath = path.join(config.OUTPUT_DIR, (realName || uid).replace(/[\\/:*?"<>|]/g, '_').trim());
        msg += `📁 归档目录: ${escapeHtml(folderRelPath)}\n`;
        msg += `</blockquote>\n`;
      }
      if (stats.errors.length > 0) {
        msg += `<blockquote expandable>\n`;
        msg += `⚠️ <b>异常提示 (${stats.errors.length} 项):</b>\n`;
        for (const e of stats.errors.slice(0, 5)) {
          msg += `• ${escapeHtml(e)}\n`;
        }
        msg += `</blockquote>\n`;
      }
      msg += `\n`;
      totalPosts += stats.postsCount;
      totalOriginal += stats.originalCount;
      totalRetweet += stats.retweetCount;
      totalComments += stats.commentsCount;
      totalRootComments += stats.rootCommentsCount;
      totalSubComments += stats.subCommentsCount;
      totalMedia += bloggerMedia;
    }
    
    msg += `====================\n`;
    msg += `📊 <b>运行数据统计汇总:</b>\n`;
    msg += `👥 运行博主总数: ${this.activeStats.size} 位\n`;
    msg += `📝 累计新增微博: ${totalPosts} 条 (原创: ${totalOriginal} | 转发: ${totalRetweet})\n`;
    if (config.SCRAPE_COMMENTS) {
      msg += `💬 累计抓取评论: ${totalComments} 条 (主评: ${totalRootComments} | 楼中楼: ${totalSubComments})\n`;
    }
    if (totalMedia > 0) {
      msg += `🖼️ 累计媒体下载: ${totalMedia} 项\n`;
    }
    msg += `⏱️ 爬虫运行耗时: ${durationSec} 秒\n`;
    msg += `✨ <b>增量同步任务全部完成！</b>`;
    
    return msg;
  }

  private generateDateSummaryMessage(uid: string, dateStr: string, durationMs: number): string {
    const stats = this.activeStats.get(uid);
    const bloggerName = this.screenNameCache.get(uid) || this.getBloggerName(uid) || stats?.name || uid;
    const displayName = (bloggerName && bloggerName !== uid && !bloggerName.startsWith('user_'))
      ? `${bloggerName} (${uid})`
      : uid;
    const sanitizedScreenName = bloggerName.replace(/[\\/:*?"<>|]/g, '_').trim();
    const monthSubDir = dateStr.substring(0, 7);

    let msg = `🎯 <b>【定向日期爬取完成报告】</b>\n\n`;
    msg += `👤 目标博主: <b>${escapeHtml(displayName)}</b>\n`;
    msg += `📅 定向日期: ${escapeHtml(dateStr)}\n`;
    msg += `⏱️ 任务耗时: ${this.formatDuration(durationMs)}\n\n`;

    if (!stats || stats.postsCount === 0) {
      msg += `ℹ️ 抓取结果: 该日期未检索到公开微博。\n`;
      msg += `（可能当天博主未发博，或所发微博均为转发博文且已被 ONLY_ORIGINAL=true 策略过滤）\n`;
    } else {
      msg += `📊 <b>数据抓取统计:</b>\n`;
      msg += `  📝 发现微博: ${stats.postsCount} 条 (原创: ${stats.originalCount} 条 | 转发: ${stats.retweetCount} 条)\n`;
      if (config.SCRAPE_COMMENTS) {
        msg += `  💬 抓取评论: ${stats.commentsCount} 条 (一级主评: ${stats.rootCommentsCount} 条 | 二级楼中楼: ${stats.subCommentsCount} 条)\n`;
      }
      const mediaTotal = stats.imagesCount + stats.videosCount + stats.livePhotosCount + stats.audiosCount;
      msg += `  🖼️ 多媒体下载: 共 ${mediaTotal} 项 (图片: ${stats.imagesCount} | 视频: ${stats.videosCount} | 实况: ${stats.livePhotosCount} | 音频: ${stats.audiosCount})\n\n`;

      if (stats.postSummaries && stats.postSummaries.length > 0) {
        const maxDisplay = 10;
        const displayList = stats.postSummaries.slice(0, maxDisplay);
        const remainingCount = stats.postSummaries.length - displayList.length;

        msg += `<blockquote expandable>\n`;
        msg += `📋 <b>博文抓取清单 (共 ${stats.postSummaries.length} 条):</b>\n`;
        for (const p of displayList) {
          const typeTag = p.isRetweet ? '[转]' : '[原]';
          const postUrl = `https://weibo.com/${uid}/${p.bid || p.id}`;
          const cleanText = p.snippet ? p.snippet.replace(/\.+$/, '').trim() : '';
          const snippetStr = cleanText ? `: ${escapeHtml(cleanText.length > 42 ? cleanText.slice(0, 42) + '...' : cleanText)}` : '';
          const mediaStr = p.mediaCount > 0 ? ` | 媒 ${p.mediaCount}` : '';
          msg += `• ${escapeHtml(p.time)} <a href="${postUrl}">${typeTag}</a> (评 ${p.commentsCount}${mediaStr})${snippetStr}\n`;
        }

        if (remainingCount > 0) {
          msg += `\n... 其余 ${remainingCount} 条博文已完整归档至本地\n`;
        }
        const folderRelPath = path.join(config.OUTPUT_DIR, sanitizedScreenName, monthSubDir);
        msg += `📁 归档目录: ${escapeHtml(folderRelPath)}\n`;
        msg += `</blockquote>\n\n`;
      }

      const folderRelPath = path.join(config.OUTPUT_DIR, sanitizedScreenName, monthSubDir);
      const formats = config.SAVE_TYPES.map(t => t.toUpperCase()).join(' / ');
      const dbText = config.DB_TYPE ? ` + 数据库(${config.DB_TYPE})` : '';
      msg += `💾 存储归档: ${escapeHtml(folderRelPath)}\n`;
      msg += `   └─ [${formats}${dbText}] 已同步完成\n`;
    }

    if (stats && stats.errors.length > 0) {
      msg += `<blockquote expandable>\n`;
      msg += `⚠️ <b>异常提示 (${stats.errors.length} 项):</b>\n`;
      for (const err of stats.errors.slice(0, 5)) {
        msg += `• ${escapeHtml(err)}\n`;
      }
      msg += `</blockquote>\n`;
    }

    msg += `\n✨ <b>该日期定向备份已顺利完成！</b>`;
    return msg;
  }

  /**
   * Crawl a user's profile feed by calling mymblog API directly
   */
  private async handleProfilePage(userData: any): Promise<void> {
    const { uid, cursor } = userData;
    const screenName = await this.getScreenName(uid);
    const stats = this.activeStats.get(uid);
    if (stats && screenName && screenName !== `user_${uid}`) {
      stats.name = screenName;
    }
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

        // Comments and storage pipeline process (with chunking threshold support)
        try {
          const comments = await this.processPostWithComments(parsedPost, screenName, uid);
          this.markPostAsCrawled(uid, postDateStr, parsedPost.id);
          this.updatePostStats(uid, parsedPost, comments);
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
      const targetEnd = userData?.effectiveEndDate || config.END_DATE;
      let cursorTimestamp = latestPostTimestamp > 0 ? latestPostTimestamp : Date.now();
      if (targetEnd && targetEnd !== getTodayString()) {
        const endTs = Date.parse(`${targetEnd}T23:59:59+08:00`);
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
    const stats = this.activeStats.get(uid);
    if (stats && screenName && screenName !== `user_${uid}`) {
      stats.name = screenName;
    }

    let latestPostTimestamp = 0;

    // Fetch detail and comments for each mid
    for (const mid of mids) {
      // Check if post is already crawled (skip check if running in targeted mode)
      const alreadyCrawled = !isTargeted && await this.isPostAlreadyCrawled(uid, screenName, currentDay, mid);
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

        const postAuthorName = postData?.user?.screen_name;
        if (postAuthorName) {
          const cached = this.screenNameCache.get(uid);
          if (!cached || cached === uid || cached.startsWith('user_')) {
            this.screenNameCache.set(uid, postAuthorName);
            this.saveBloggerNameToUserFile(uid, postAuthorName);
          }
          const s = this.activeStats.get(uid);
          if (s && (!s.name || s.name === uid || s.name.startsWith('user_'))) {
            s.name = postAuthorName;
          }
        }

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

        // Fetch comments and dispatch to storage (with chunking threshold support)
        const comments = await this.processPostWithComments(parsedPost, screenName, uid);
        this.markPostAsCrawled(uid, currentDay, parsedPost.id);
        this.updatePostStats(uid, parsedPost, comments);

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
        const targetEnd = effectiveEndDate || config.END_DATE;
        if (targetEnd && currentDay === targetEnd) {
          if (targetEnd !== getTodayString()) {
            const endTs = Date.parse(`${targetEnd}T23:59:59+08:00`);
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
   * 综合处理单条博文及评论的持久化。
   * 根据 COMMENT_CHUNKING_THRESHOLD 阈值自适应策略：
   * - 若评论量达到阈值：采用“正文优先安全落盘 + 评论分批流式落盘与断点暂存”；
   * - 若评论量未达阈值：采用原生轻量一次性模式。
   */
  private async processPostWithComments(
    parsedPost: ParsedPost,
    screenName: string,
    uid: string
  ): Promise<ParsedComment[]> {
    let comments: ParsedComment[] = [];
    const threshold = config.COMMENT_CHUNKING_THRESHOLD;
    const postCommentsCount = parsedPost.comments_count || 0;
    const userLimit = config.MAX_COMMENTS_PER_POST;
    // 实际预计爬取的评论数量：受博文本身评论总数与用户配置的上限共同约束
    const expectedComments = userLimit > 0 
      ? Math.min(postCommentsCount, userLimit) 
      : postCommentsCount;

    const shouldStream = threshold > 0 && config.SCRAPE_COMMENTS && expectedComments >= threshold;

    if (shouldStream) {
      logger.info(`[流式策略] 微博 ${parsedPost.id} 预计爬取评论较多 (${expectedComments}条，阈值: ${threshold})，启用正文优先归档与评论流式同步...`);
      // 1. 先行安全归档博文正文及超清媒体，确保后续网络中断不丢失正文与视频/图片
      await this.pipeline.processPost(parsedPost, screenName, uid);

      // 2. 流式抓取评论，边抓边存（写入数据库与 CSV，定期刷新检查点）
      comments = await this.scrapeComments(parsedPost.id, uid, async (batch) => {
        await this.pipeline.appendCommentsBatch(parsedPost, batch, screenName, uid);
      });

      // 3. 最终全量同步更新（Markdown 原地替换，日 JSON 替换更新）
      await this.pipeline.finishPostComments(parsedPost, comments, screenName, uid);
    } else {
      // 传统轻量模式
      if (config.SCRAPE_COMMENTS && parsedPost.comments_count > 0) {
        comments = await this.scrapeComments(parsedPost.id, uid);
      }
      await this.pipeline.process(parsedPost, comments, screenName, uid);
    }

    // 若顺利完成（非用户或系统异常中断），清理已安全落盘的临时断点文件
    if (!this.isAborted) {
      CommentCheckpointManager.clearCheckpoint(parsedPost.id);
    }

    return comments;
  }

  /**
   * Scrapes comments for a post, including sub-comments.
   * 支持断点检查点恢复 (Checkpoint Resume)、分批刷盘暂存以及流式落盘回调 (onBatch)。
   */
  private async scrapeComments(
    postId: string,
    uid: string,
    onBatch?: (batch: ParsedComment[]) => Promise<void>
  ): Promise<ParsedComment[]> {
    const parsedComments: ParsedComment[] = [];
    const seenCommentIds = new Set<string>();
    const limit = config.MAX_COMMENTS_PER_POST <= 0 ? Infinity : config.MAX_COMMENTS_PER_POST;

    // 检查是否存在断点检查点
    const checkpoint = CommentCheckpointManager.loadCheckpoint(postId);
    if (checkpoint && checkpoint.comments.length > 0) {
      for (const c of checkpoint.comments) {
        if (!seenCommentIds.has(c.id)) {
          seenCommentIds.add(c.id);
          parsedComments.push(c);
        }
      }
      logger.info(`[断点检查点] 发现微博 ${postId} 已暂存的 ${parsedComments.length} 条评论，已恢复已有进度！`);
    }

    const spinner = new Spinner(`正在获取微博 ID: ${postId} 的评论列表: 已获取 ${parsedComments.length} 条...`);
    if (process.stdout.isTTY) {
      spinner.start();
    } else {
      logger.info(`正在获取微博 ID: ${postId} 的评论列表: 已获取 ${parsedComments.length} 条...`);
    }

    // 维护流式批量暂存与落盘状态
    let lastFlushedCount = parsedComments.length;
    let pendingBatch: ParsedComment[] = [];

    const flushBatch = async () => {
      if (pendingBatch.length > 0) {
        if (onBatch) {
          try {
            await onBatch([...pendingBatch]);
          } catch (e: any) {
            logger.error(`流式落盘批次写入出错: ${e.message}`);
          }
        }
        pendingBatch = [];
      }
      if (parsedComments.length > lastFlushedCount) {
        CommentCheckpointManager.saveCheckpoint(postId, uid, parsedComments);
        lastFlushedCount = parsedComments.length;
      }
    };

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
      if (parsedComments.length >= limit || this.isAborted) break;

      let maxId = '0';
      let keepFetching = true;
      const seenMaxIds = new Set<string>();

      while (keepFetching && parsedComments.length < limit && !this.isAborted) {
        if (seenMaxIds.has(maxId)) {
          break;
        }
        seenMaxIds.add(maxId);

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

        if (this.isAborted) break;

        const data = commentsData?.data || [];
        if (data.length === 0) {
          break;
        }

        for (const rawComment of data) {
          if (this.isAborted) break;
          const parsedComment = parseComment(rawComment, postId);
          if (!seenCommentIds.has(parsedComment.id)) {
            seenCommentIds.add(parsedComment.id);
            parsedComments.push(parsedComment);
            pendingBatch.push(parsedComment);
          }

          const rawReplies = rawComment.comments || [];
          for (const rawReply of rawReplies) {
            if (this.isAborted) break;
            const parsedReply = parseComment(rawReply, postId, parsedComment.id);
            if (!seenCommentIds.has(parsedReply.id)) {
              seenCommentIds.add(parsedReply.id);
              parsedComments.push(parsedReply);
              pendingBatch.push(parsedReply);
            }
          }

          const totalNumber = rawComment.total_number || 0;
          if (!this.isAborted && totalNumber > rawReplies.length && parsedComments.length < limit) {
            spinner.updateText(`正在获取微博 ID: ${postId} 的评论列表: 已获取 ${parsedComments.length} 条 (正在补充楼中楼回复)...`);
            const subLimitSetting = config.MAX_SUB_COMMENTS_PER_COMMENT <= 0 ? Infinity : config.MAX_SUB_COMMENTS_PER_COMMENT;
            const remainingQuota = limit === Infinity ? Infinity : Math.max(0, limit - parsedComments.length);
            const maxSubForThisComment = Math.min(subLimitSetting, remainingQuota);

            if (maxSubForThisComment > 0) {
              const fetchedReplies = await this.scrapeSubComments(postId, parsedComment.id, uid, maxSubForThisComment);
              for (const reply of fetchedReplies) {
                if (!seenCommentIds.has(reply.id)) {
                  seenCommentIds.add(reply.id);
                  parsedComments.push(reply);
                  pendingBatch.push(reply);
                }
                if (parsedComments.length >= limit || this.isAborted) break;
              }
            }
          }

          if (parsedComments.length >= limit || this.isAborted) {
            break;
          }
        }

        // 检查是否达到分批暂存/流式刷盘阈值（累积 100 条）
        if (pendingBatch.length >= 100 || parsedComments.length - lastFlushedCount >= 100) {
          await flushBatch();
        }

        spinner.updateText(`正在获取微博 ID: ${postId} 的评论列表: 已获取 ${parsedComments.length} 条...`);

        if (this.isAborted) break;

        const nextMaxId = commentsData?.max_id?.toString() || '0';
        if (nextMaxId === '0' || nextMaxId === '' || seenMaxIds.has(nextMaxId)) {
          keepFetching = false;
        } else {
          maxId = nextMaxId;
          await new Promise(resolve => setTimeout(resolve, config.REQUEST_DELAY_MIN + Math.random() * (config.REQUEST_DELAY_MAX - config.REQUEST_DELAY_MIN)));
        }
      }
    }

    // 循环结束后刷写剩余未落盘批次
    await flushBatch();

    if (this.isAborted) {
      const msg = `⚠️ 微博 ${postId} 评论抓取已响应中断，中断前已安全捕获 ${parsedComments.length} 条评论并存入检查点`;
      if (process.stdout.isTTY) {
        spinner.stop(msg);
      } else {
        logger.warn(msg);
      }
      return parsedComments;
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
    const seenSubIds = new Set<string>();
    let maxId = '0';
    let keepFetching = true;
    const seenSubMaxIds = new Set<string>();

    while (keepFetching && subComments.length < maxSub && !this.isAborted) {
      if (seenSubMaxIds.has(maxId)) {
        break;
      }
      seenSubMaxIds.add(maxId);

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
        const parsed = parseComment(rawSubComment, postId, parentCommentId);
        if (!seenSubIds.has(parsed.id)) {
          seenSubIds.add(parsed.id);
          subComments.push(parsed);
        }
        if (subComments.length >= maxSub) break;
      }

      const nextMaxId = subCommentsData?.max_id?.toString() || '0';
      if (nextMaxId === '0' || nextMaxId === '' || seenSubMaxIds.has(nextMaxId)) {
        keepFetching = false;
      } else {
        maxId = nextMaxId;
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

  private getCursorForUser(uid: string): number {
    if (!isUserListFile()) return 0;
    try {
      const users = readUsers();
      const match = users.find((u: any) => u.uid === uid && !u.isCommented);
      if (match?.cursor) {
        return parseCursorToTimestamp(match.cursor);
      }
    } catch (err) {
      logger.error(`Error reading cursor for UID ${uid}`, err);
    }
    return 0;
  }

  private updateCursorForUser(uid: string, name: string, timestamp: number): void {
    if (!isUserListFile()) return;
    try {
      const currentCursor = this.getCursorForUser(uid);
      if (currentCursor > 0 && timestamp <= currentCursor) {
        logger.info(`跳过游标更新: 新时间戳 (${timestamp}) 小于或等于现有游标 (${currentCursor})，防止游标倒退。`);
        return;
      }

      const dateStr = getBeijingDateParts(timestamp).isoStr;
      const users = readUsers();
      const user = users.find((u: any) => u.uid === uid);
      if (user) {
        user.cursor = dateStr;
        if (name && !user.name) {
          user.name = name;
        }
        writeUsers(users);
      } else {
        users.push({ uid, name, cursor: dateStr, isCommented: false });
        writeUsers(users);
      }
      logger.info(`Updated cursor file for ${name || uid} (${uid}) to date ${dateStr} (timestamp: ${timestamp})`);
    } catch (err) {
      logger.error(`Failed to update cursor for UID ${uid}`, err);
    }
  }

  private saveBloggerNameToUserFile(uid: string, name: string): void {
    if (!isUserListFile()) return;
    try {
      const users = readUsers();
      const user = users.find((u: any) => u.uid === uid);
      if (user && !user.name) {
        user.name = name;
        writeUsers(users);
        logger.info(`已成功将博主 ${name} (${uid}) 的昵称持久化保存至用户文件`);
      }
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

    // 2. 只有当本地没有昵称记录（如首次仅填写了 UID）时，通过博主资料管理器获取
    try {
      logger.info(`博主 UID ${uid} 本地无昵称记录，正在从微博接口获取博主资料与昵称...`);
      const profile = await BloggerProfileManager.getInstance().ensureBloggerProfile(uid);
      if (profile?.screenName) {
        this.screenNameCache.set(uid, profile.screenName);
        this.saveBloggerNameToUserFile(uid, profile.screenName);
        return profile.screenName;
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
  async crawlSinglePost(urlOrIdOrBid: string, triggerSource: 'CLI' | 'TG_BOT' = 'CLI'): Promise<{ success: boolean; message: string }> {
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

    const startTime = Date.now();
    logger.info(`Starting targeted crawl for post: ${rawId} (resolved MID: ${mid})...`);

    // Ensure session is active
    await AuthManager.ensureLogin("✅ 扫码登录成功！正在开始抓取单条微博，请稍候...");

    // Initialize pipeline
    await this.pipeline.initialize();

    let targetAuthorUid = "";

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
      targetAuthorUid = uid;
      const screenName = postData?.user?.screen_name || `user_${uid}`;

      if (!uid) {
        throw new Error("Unable to resolve post author UID from API response.");
      }

      logger.info(`已解析作者: ${screenName} (UID: ${uid})`);

      // 确保单条定向抓取的目标博主详细资料（<UID>.txt 及 profile/ 头像与背景图片）已生成归档
      await BloggerProfileManager.getInstance().ensureBloggerProfile(uid, screenName);

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

      // Fetch comments and process storage pipeline (with chunking threshold support)
      const comments = await this.processPostWithComments(parsedPost, screenName, uid);
      const postDateStr = parsedPost.time.substring(0, 10);
      this.markPostAsCrawled(uid, postDateStr, parsedPost.id);

      const durationMs = Date.now() - startTime;
      const sanitizedScreenName = screenName.replace(/[\\/:*?"<>|]/g, '_').trim();
      const monthSubDir = postDateStr.substring(0, 7);
      const rootCommentsCount = comments.filter(c => !c.parent_id).length;
      const subCommentsCount = comments.filter(c => !!c.parent_id).length;
      const mediaTotal = (parsedPost.local_images?.length || 0) + 
                         (parsedPost.local_videos?.length || 0) + 
                         (parsedPost.local_livephotos?.length || 0) + 
                         (parsedPost.local_audios?.length || 0);

      const contentSnippet = parsedPost.content
        ? (parsedPost.content.length > 60 ? parsedPost.content.substring(0, 60) + '...' : parsedPost.content)
        : '（无正文或仅含媒体）';

      let msg = this.isAborted
        ? `⚠️ <b>【单条微博定向爬取中断保存报告】</b>\n\n`
        : `🎯 <b>【单条微博定向爬取完成报告】</b>\n\n`;
      msg += `👤 目标博主: <b>${escapeHtml(screenName)}</b> (${uid})\n`;
      msg += `🆔 微博 ID: <code>${mid}</code>\n`;
      msg += `🔗 博文链接: https://weibo.com/${uid}/${mid}\n`;
      msg += `📅 发布时间: ${parsedPost.time ? parsedPost.time.replace('T', ' ').replace(/\+08:00$/, '') : '未知'}${parsedPost.device ? ` (来自 ${escapeHtml(parsedPost.device)})` : ''}\n`;
      msg += `📍 发布位置: ${escapeHtml(parsedPost.ip_location || '未知')}\n`;
      msg += `⏱️ 任务耗时: ${this.formatDuration(durationMs)}\n\n`;

      msg += `<blockquote expandable>\n`;
      msg += `📝 <b>微博正文摘录:</b>\n“${escapeHtml(contentSnippet.replace(/\n/g, ' '))}”\n`;
      msg += `</blockquote>\n\n`;

      msg += `📊 <b>互动与抓取统计:</b>\n`;
      msg += `  🔁 转发: ${parsedPost.reposts_count} | 💬 评论: ${parsedPost.comments_count} | 👍 点赞: ${parsedPost.attitudes_count}\n`;
      if (config.SCRAPE_COMMENTS) {
        msg += `  💬 实爬评论: ${comments.length} 条 (一级主评: ${rootCommentsCount} 条 | 二级楼中楼: ${subCommentsCount} 条)\n`;
      }
      msg += `  🖼️ 多媒体文件: 共 ${mediaTotal} 项 (图片: ${parsedPost.local_images?.length || 0} | 视频: ${parsedPost.local_videos?.length || 0} | 实况: ${parsedPost.local_livephotos?.length || 0} | 语音: ${parsedPost.local_audios?.length || 0})\n\n`;

      const folderRelPath = path.join(config.OUTPUT_DIR, sanitizedScreenName, monthSubDir);
      const formats = config.SAVE_TYPES.map(t => t.toUpperCase()).join(' / ');
      const dbText = config.DB_TYPE ? ` + 数据库(${config.DB_TYPE})` : '';
      msg += `💾 存储归档: ${escapeHtml(folderRelPath)}\n`;
      msg += `   └─ [${formats}${dbText}] 已同步备份\n`;

      msg += this.isAborted
        ? `\n⚠️ <b>任务已被手动中断，但已成功安全归档当前全部进度！</b>`
        : `\n✨ <b>单条微博定向备份成功！</b>`;

      const durationSec = parseFloat((durationMs / 1000).toFixed(1));
      const hookContext: HookContext = {
        status: 'SUCCESS',
        taskType: 'TARGETED_POST',
        triggerSource,
        postsCount: 1,
        mediaCount: mediaTotal,
        commentsCount: comments.length,
        targetUsers: uid ? [uid] : [],
        durationSec,
        summaryText: msg
      };

      const hookRes = await executePostScript(hookContext);
      if (hookRes.executed) {
        msg += formatHookSummaryForReport(hookRes);
      }

      return {
        success: true,
        message: msg
      };
    } catch (err: any) {
      logger.error(`定向微博 ${mid} 抓取失败:`, err);
      const durationMs = Date.now() - startTime;
      let errMsg = `抓取微博失败: ${err.message || err} (耗时: ${this.formatDuration(durationMs)})`;

      const isSessionExpired = err instanceof SessionExpiredError || err.message?.includes('检测到登录会话过期');
      const hookContext: HookContext = {
        status: isSessionExpired ? 'SESSION_EXPIRED' : 'FAILED',
        taskType: 'TARGETED_POST',
        triggerSource,
        postsCount: 0,
        mediaCount: 0,
        commentsCount: 0,
        targetUsers: targetAuthorUid ? [targetAuthorUid] : [],
        durationSec: parseFloat((durationMs / 1000).toFixed(1)),
        summaryText: errMsg
      };
      const hookRes = await executePostScript(hookContext);
      if (hookRes.executed) {
        errMsg += formatHookSummaryForReport(hookRes);
      }

      return { success: false, message: errMsg };
    }
  }

  /**
   * Crawl all posts of a specific date for a specific UID
   */
  async crawlDateForUser(uid: string, dateStr: string, triggerSource: 'CLI' | 'TG_BOT' = 'CLI'): Promise<{ success: boolean; message: string }> {
    // 自动同步并归档博主详细资料（<UID>.txt 及 profile/ 头像与背景图片）
    const knownName = this.getBloggerName(uid);
    const profile = await BloggerProfileManager.getInstance().ensureBloggerProfile(uid, knownName);
    const bloggerName = profile?.screenName || (await this.getScreenName(uid)) || knownName || uid;
    const displayName = bloggerName === uid ? uid : `${bloggerName} (${uid})`;
    logger.info(`正在对 ${displayName} 在日期 ${dateStr} 启动定向爬取...`);

    const startTime = Date.now();
    this.activeStats.set(uid, {
      name: bloggerName,
      postsCount: 0,
      originalCount: 0,
      retweetCount: 0,
      commentsCount: 0,
      rootCommentsCount: 0,
      subCommentsCount: 0,
      imagesCount: 0,
      videosCount: 0,
      livePhotosCount: 0,
      audiosCount: 0,
      dateRange: dateStr,
      errors: [],
      postSummaries: []
    });

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
      
      const durationMs = Date.now() - startTime;
      let message = this.generateDateSummaryMessage(uid, dateStr, durationMs);

      const stats = this.activeStats.get(uid);
      const postsCount = stats?.postsCount || 0;
      const mediaCount = (stats?.imagesCount || 0) + (stats?.videosCount || 0) + (stats?.livePhotosCount || 0) + (stats?.audiosCount || 0);
      const commentsCount = stats?.commentsCount || 0;

      const hookContext: HookContext = {
        status: 'SUCCESS',
        taskType: 'TARGETED_DATE',
        triggerSource,
        postsCount,
        mediaCount,
        commentsCount,
        targetUsers: [uid],
        durationSec: parseFloat((durationMs / 1000).toFixed(1)),
        summaryText: message
      };

      const hookRes = await executePostScript(hookContext);
      if (hookRes.executed) {
        message += formatHookSummaryForReport(hookRes);
      }

      return { success: true, message };
    } catch (err: any) {
      logger.error(`定向日期爬取失败:`, err);
      const durationMs = Date.now() - startTime;
      let errMsg = `定向爬取 ${displayName} 在日期 ${dateStr} 失败: ${err.message || err} (耗时: ${this.formatDuration(durationMs)})`;

      const stats = this.activeStats.get(uid);
      const isSessionExpired = err instanceof SessionExpiredError || err.message?.includes('检测到登录会话过期');
      const hookContext: HookContext = {
        status: isSessionExpired ? 'SESSION_EXPIRED' : 'FAILED',
        taskType: 'TARGETED_DATE',
        triggerSource,
        postsCount: stats?.postsCount || 0,
        mediaCount: (stats?.imagesCount || 0) + (stats?.videosCount || 0) + (stats?.livePhotosCount || 0) + (stats?.audiosCount || 0),
        commentsCount: stats?.commentsCount || 0,
        targetUsers: [uid],
        durationSec: parseFloat((durationMs / 1000).toFixed(1)),
        summaryText: errMsg
      };
      const hookRes = await executePostScript(hookContext);
      if (hookRes.executed) {
        errMsg += formatHookSummaryForReport(hookRes);
      }

      return {
        success: false,
        message: errMsg
      };
    }
  }
}
