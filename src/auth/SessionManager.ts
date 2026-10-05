import * as fs from 'fs';
import * as path from 'path';
import axios, { AxiosResponse } from 'axios';
import { config } from '../config';
import { logger } from '../utils/logger';
import { CookieJar, WeiboCookie } from '../utils/cookieHelper';
import { getAxiosProxyConfig } from '../utils/proxyHelper';
import { SessionMetadata, SessionStateV2, SessionExpiredError } from './types';

export class SessionManager {
  private static instance: SessionManager;
  private jar: CookieJar = new CookieJar();
  private metadata: SessionMetadata = {
    createdAt: 0,
    lastValidatedAt: 0,
    lastRefreshAt: 0,
    lastCookieUpdateAt: 0
  };
  private isLoaded = false;
  private keepAliveTimer: NodeJS.Timeout | null = null;

  public static getInstance(): SessionManager {
    if (!SessionManager.instance) {
      SessionManager.instance = new SessionManager();
    }
    return SessionManager.instance;
  }

  constructor() {}

  /**
   * Load session from state.json, auto-migrating v1 format to v2 format.
   */
  public load(stateFilePath: string = config.STATE_FILE): void {
    if (!fs.existsSync(stateFilePath)) {
      this.jar = new CookieJar();
      this.metadata = {
        createdAt: 0,
        lastValidatedAt: 0,
        lastRefreshAt: 0,
        lastCookieUpdateAt: 0
      };
      this.isLoaded = true;
      return;
    }

    try {
      const content = fs.readFileSync(stateFilePath, 'utf8');
      const parsed = JSON.parse(content);

      if (!parsed.version || parsed.version < 2) {
        // Migrate v1 to v2
        logger.info('[Auth] 检测到旧版 (v1) 会话状态文件，正在自动迁移至 v2 格式...');
        let fileTime = Date.now();
        try {
          const stats = fs.statSync(stateFilePath);
          fileTime = stats.mtimeMs || stats.birthtimeMs || Date.now();
        } catch {}

        this.jar.load(stateFilePath);
        this.metadata = {
          createdAt: Math.floor(fileTime),
          lastValidatedAt: 0,
          lastRefreshAt: 0,
          lastCookieUpdateAt: Math.floor(fileTime)
        };
        this.isLoaded = true;

        // Persist migrated version immediately
        this.save(stateFilePath);
        logger.info('[Auth] 会话状态已成功升级至 v2 格式。');
      } else {
        // v2 format
        this.jar.load(stateFilePath);
        const meta = parsed.session || {};
        this.metadata = {
          createdAt: typeof meta.createdAt === 'number' ? meta.createdAt : Date.now(),
          lastValidatedAt: typeof meta.lastValidatedAt === 'number' ? meta.lastValidatedAt : 0,
          lastRefreshAt: typeof meta.lastRefreshAt === 'number' ? meta.lastRefreshAt : 0,
          lastCookieUpdateAt: typeof meta.lastCookieUpdateAt === 'number' ? meta.lastCookieUpdateAt : 0,
          uid: meta.uid,
          screenName: meta.screenName
        };
        this.isLoaded = true;
        logger.info(`[Auth] 成功载入持久化会话凭证 (Cookies: ${this.jar.getCookies().length}, 上次更新: ${this.metadata.lastCookieUpdateAt ? new Date(this.metadata.lastCookieUpdateAt).toLocaleString() : '无'})`);
      }
    } catch (err: any) {
      logger.error(`[Auth] 读取或解析会话文件失败: ${err.message}`);
      this.jar = new CookieJar();
      this.metadata = {
        createdAt: 0,
        lastValidatedAt: 0,
        lastRefreshAt: 0,
        lastCookieUpdateAt: 0
      };
      this.isLoaded = true;
    }
  }

  /**
   * Save current session and metadata to state.json in v2 format.
   */
  public save(stateFilePath: string = config.STATE_FILE): void {
    try {
      const dir = path.dirname(stateFilePath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }

      const state: SessionStateV2 = {
        version: 2,
        cookies: this.jar.getCookies(),
        session: {
          ...this.metadata
        },
        origins: []
      };

      const tmpPath = `${stateFilePath}.tmp`;
      fs.writeFileSync(tmpPath, JSON.stringify(state, null, 2), 'utf8');
      try {
        fs.renameSync(tmpPath, stateFilePath);
      } catch {
        // Fallback for Windows cross-device or file locking: copy and unlink
        fs.copyFileSync(tmpPath, stateFilePath);
        fs.unlinkSync(tmpPath);
      }
      logger.debug(`[Auth] 会话状态已安全落盘至 ${stateFilePath}`);
    } catch (err: any) {
      logger.error(`[Auth] 保存会话状态文件失败: ${err.message}`);
    }
  }

  /**
   * Get Cookie header for target URL
   */
  public getCookieHeader(targetUrl: string): string {
    this.ensureLoaded();
    return this.jar.getCookieHeader(targetUrl);
  }

  /**
   * Process HTTP response to extract Set-Cookie headers, update jar and persist state.
   */
  public processResponse(response: AxiosResponse, requestUrl: string): void {
    this.ensureLoaded();
    const setCookie = response.headers ? response.headers['set-cookie'] : undefined;
    if (setCookie) {
      const addedCount = this.jar.addCookies(setCookie, requestUrl);
      if (addedCount > 0) {
        this.metadata.lastCookieUpdateAt = Date.now();
        this.save();
        logger.debug(`[Auth] 被动续期：已更新 ${addedCount} 条 Cookie 凭据至本地状态库。`);
      }
    }
  }

  /**
   * Check if current session has non-expired SUB cookie in jar.
   */
  public isAuthenticated(): boolean {
    this.ensureLoaded();
    const cookies = this.jar.getCookies();
    const subCookie = cookies.find(c => c.name === 'SUB');
    if (!subCookie) {
      return false;
    }
    // If expires is present, ensure not expired
    if (subCookie.expires !== null && subCookie.expires !== undefined) {
      return subCookie.expires > Math.floor(Date.now() / 1000);
    }
    return true;
  }

  /**
   * Remote validation of current session.
   * @param force whether to bypass throttle cache
   */
  public async validate(force: boolean = false): Promise<boolean> {
    this.ensureLoaded();

    if (!this.isAuthenticated()) {
      logger.warn('[Auth] 本地无有效的 SUB Cookie 凭据，判定为未登录状态。');
      return false;
    }

    // Debounce / throttle check: if validated within the last 3 minutes and not forced, reuse result
    const now = Date.now();
    const throttleMs = 3 * 60 * 1000;
    if (!force && this.metadata.lastValidatedAt > 0 && (now - this.metadata.lastValidatedAt < throttleMs)) {
      logger.debug('[Auth] 最近 3 分钟内已完成在线会话校验，直接信任当前会话状态。');
      return true;
    }

    logger.info('[Auth] 正在向微博服务器进行会话在线有效性校验 (ajax/config)...');
    const testUrl = 'https://weibo.com/ajax/config';

    try {
      const response = await axios({
        url: testUrl,
        method: 'GET',
        proxy: getAxiosProxyConfig(),
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          'Referer': 'https://weibo.com/',
          'X-Requested-With': 'XMLHttpRequest',
          'Accept': 'application/json, text/plain, */*',
          'Cookie': this.getCookieHeader(testUrl)
        },
        timeout: 10000,
        maxRedirects: 5,
        validateStatus: (status) => status >= 200 && status < 400
      });

      this.processResponse(response, testUrl);

      const finalUrl = response.request?.res?.responseUrl || testUrl;
      const data = response.data;

      if (finalUrl.includes('passport.weibo.com') || finalUrl.includes('login.php')) {
        logger.warn('[Auth] 在线校验未通过：请求被重定向至登录认证页面。');
        return false;
      }

      if (data) {
        if (data.isLogin === false || data.ok === -100 || data.ok === 0) {
          logger.warn(`[Auth] 在线校验未通过：服务端明确返回未登录状态 (ok: ${data.ok}, isLogin: ${data.isLogin})。`);
          return false;
        }
        if (typeof data.url === 'string' && (data.url.includes('login.php') || data.url.includes('passport.weibo.com'))) {
          logger.warn(`[Auth] 在线校验未通过：接口指示需要重新登录 (跳转 URL: ${data.url})。`);
          return false;
        }
      }

      this.metadata.lastValidatedAt = Date.now();
      this.save();
      logger.info('[Auth] 在线校验成功：微博服务端会话依然有效。');
      return true;

    } catch (err: any) {
      const status = err.response?.status;
      const finalUrl = err.response?.request?.res?.responseUrl || '';

      if (status === 401 || finalUrl.includes('passport.weibo.com') || finalUrl.includes('login.php')) {
        logger.warn(`[Auth] 在线校验失败：服务器返回状态码 ${status || 'Redirect'}，会话明确已失效。`);
        return false;
      }

      // Secondary fallback check on s.weibo.com in case ajax/config is affected by transient WAF or network
      logger.warn(`[Auth] 主校验接口 (ajax/config) 返回异常 [${status || err.message}]，尝试备用校验 (s.weibo.com)...`);
      try {
        const fallbackUrl = 'https://s.weibo.com/weibo?q=test';
        const fallbackRes = await axios({
          url: fallbackUrl,
          method: 'GET',
          proxy: getAxiosProxyConfig(),
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
            'Referer': 'https://s.weibo.com/',
            'Cookie': this.getCookieHeader(fallbackUrl)
          },
          timeout: 10000,
          maxRedirects: 5,
          validateStatus: (s) => s >= 200 && s < 400
        });

        this.processResponse(fallbackRes, fallbackUrl);

        const fbFinalUrl = fallbackRes.request?.res?.responseUrl || fallbackUrl;
        const fbBody = typeof fallbackRes.data === 'string' ? fallbackRes.data : '';

        if (fbFinalUrl.includes('passport.weibo.com') || fbFinalUrl.includes('login.php') || fbBody.includes('retcode=6102') || fbBody.includes('location.replace')) {
          logger.warn('[Auth] 备用校验未通过：页面被拦截或重定向至登录页。会话已失效。');
          return false;
        }

        this.metadata.lastValidatedAt = Date.now();
        this.save();
        logger.info('[Auth] 备用校验成功：s.weibo.com 可正常访问，判定会话有效。');
        return true;
      } catch (fbErr: any) {
        const fbStatus = fbErr.response?.status;
        const fbFinalUrl = fbErr.response?.request?.res?.responseUrl || '';
        if (fbStatus === 401 || fbFinalUrl.includes('passport.weibo.com') || fbFinalUrl.includes('login.php')) {
          logger.warn(`[Auth] 备用校验失败：返回 ${fbStatus || 'Redirect'}，确认会话已失效。`);
          return false;
        }
      }

      // If both checks failed with network/timeout errors, but local SUB is present, do not destroy session
      logger.warn(`[Auth] 网络异常或受阻 (${status || err.message})。鉴于本地 SUB Cookie 尚未过期，暂时信任本地凭证以允许重试...`);
      return true;
    }
  }

  /**
   * Active renewal / refresh of session via lightweight profile info endpoint.
   * This updates rolling session cookies on Weibo server.
   */
  public async refresh(): Promise<boolean> {
    this.ensureLoaded();

    if (!this.isAuthenticated()) {
      logger.warn('[Auth] 会话刷新跳过：无有效本地凭证。');
      return false;
    }

    logger.info('[Auth] 正在向微博发送轻量心跳/续期请求 (ajax/profile/info)...');
    const refreshUrl = 'https://weibo.com/ajax/profile/info?custom=1';

    try {
      const response = await axios({
        url: refreshUrl,
        method: 'GET',
        proxy: getAxiosProxyConfig(),
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          'Referer': 'https://weibo.com/',
          'Accept': 'application/json, text/plain, */*',
          'Cookie': this.getCookieHeader(refreshUrl)
        },
        timeout: 10000,
        maxRedirects: 5,
        validateStatus: (status) => status >= 200 && status < 400
      });

      this.processResponse(response, refreshUrl);

      const finalUrl = response.request?.res?.responseUrl || refreshUrl;
      const data = response.data;

      if (finalUrl.includes('passport.weibo.com') || finalUrl.includes('login.php')) {
        logger.warn('[Auth] 会话续期失败：服务器将请求重定向至登录页。');
        return false;
      }

      if (data) {
        if (data.ok === -100 || (typeof data.url === 'string' && data.url.includes('login.php'))) {
          logger.warn('[Auth] 会话续期失败：微博服务器指示登录态已失效。');
          return false;
        }

        if (data.ok === 1 && data.data?.user) {
          const user = data.data.user;
          this.metadata.uid = String(user.idstr || user.id || '');
          this.metadata.screenName = String(user.screen_name || '');
          this.metadata.lastRefreshAt = Date.now();
          this.metadata.lastValidatedAt = Date.now();
          this.save();
          logger.info(`[Auth] 会话续期成功！当前登录博主: ${this.metadata.screenName || this.metadata.uid}，Session 活跃期已成功顺延。`);
          return true;
        }
      }

      // If status 200 and no explicit error, still consider refreshed
      this.metadata.lastRefreshAt = Date.now();
      this.metadata.lastValidatedAt = Date.now();
      this.save();
      logger.info('[Auth] 会话轻量心跳发送完毕，凭据已刷新。');
      return true;

    } catch (err: any) {
      const status = err.response?.status;
      logger.warn(`[Auth] 会话续期请求遇到异常 (${status || err.message})，维持既有会话状态。`);
      return false;
    }
  }

  /**
   * Start periodic keep-alive timer for daemon mode.
   */
  public startKeepAlive(intervalMs?: number): void {
    if (this.keepAliveTimer) {
      clearInterval(this.keepAliveTimer);
      this.keepAliveTimer = null;
    }

    const interval = intervalMs || config.WEIBO_SESSION_REFRESH_INTERVAL || (12 * 60 * 60 * 1000);
    logger.info(`[Auth] 守护进程模式：已启动 Session Keep-Alive 周期续期定时器（间隔: ${Math.round(interval / 3600000)} 小时）`);

    this.keepAliveTimer = setInterval(async () => {
      try {
        logger.info('[Auth] 定时触发 Session 自动续期任务...');
        await this.refresh();
      } catch (err: any) {
        logger.error(`[Auth] 定时自动续期任务执行出错: ${err.message}`);
      }
    }, interval);

    // Prevent keep-alive timer from holding process exit if unref available
    if (this.keepAliveTimer.unref) {
      this.keepAliveTimer.unref();
    }
  }

  /**
   * Stop keep-alive timer.
   */
  public stopKeepAlive(): void {
    if (this.keepAliveTimer) {
      clearInterval(this.keepAliveTimer);
      this.keepAliveTimer = null;
      logger.debug('[Auth] Session Keep-Alive 定时器已关闭。');
    }
  }

  /**
   * Explicit logout: clears in-memory cookies and removes state.json safely.
   */
  public clear(stateFilePath: string = config.STATE_FILE): void {
    this.stopKeepAlive();
    this.jar.clear();
    this.metadata = {
      createdAt: 0,
      lastValidatedAt: 0,
      lastRefreshAt: 0,
      lastCookieUpdateAt: 0
    };
    if (fs.existsSync(stateFilePath)) {
      try {
        fs.unlinkSync(stateFilePath);
        logger.info(`[Auth] 本地会话状态文件 ${stateFilePath} 已安全清除。`);
      } catch (err: any) {
        logger.error(`[Auth] 清理状态文件失败: ${err.message}`);
      }
    }
  }

  public getJar(): CookieJar {
    this.ensureLoaded();
    return this.jar;
  }

  public getMetadata(): SessionMetadata {
    this.ensureLoaded();
    return { ...this.metadata };
  }

  public setCookies(cookies: WeiboCookie[]): void {
    this.ensureLoaded();
    this.jar.setCookies(cookies);
    this.metadata.lastCookieUpdateAt = Date.now();
    this.save();
  }

  private ensureLoaded(): void {
    if (!this.isLoaded) {
      this.load();
    }
  }
}

export const sessionManager = SessionManager.getInstance();
