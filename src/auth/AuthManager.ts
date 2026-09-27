import * as fs from 'fs';
import * as path from 'path';
import { PNG } from 'pngjs';
import jsQR from 'jsqr';
import * as qrcodeTerminal from 'qrcode-terminal';
import axios from 'axios';
import { config } from '../config';
import { logger } from '../utils/logger';
import { Notifier } from '../utils/notifier';
import { CookieJar } from '../utils/cookieHelper';

export class AuthManager {
  /**
   * Main entry point to ensure browser is authenticated.
   * If session is valid, it does nothing. Otherwise, it triggers the selected login flow.
   */
  static async ensureLogin(onSuccessNotify?: string): Promise<void> {
    logger.info('Checking authentication state...');

    const stateExists = fs.existsSync(config.STATE_FILE);

    if (stateExists) {
      logger.info(`Found existing session state file at ${config.STATE_FILE}`);
      if (!await this.isSessionExpired()) {
        logger.info('Session is valid and not expired. Skipping QR login.');
        return;
      }
      logger.warn('Session is expired or invalid. Re-authenticating...');

      if (config.LOGIN_MODE === 'LOCAL_SYNC') {
        const errMsg = `State file ${config.STATE_FILE} session is expired, and LOGIN_MODE is set to LOCAL_SYNC. Please manually regenerate state.json.`;
        logger.error(errMsg);
        throw new Error(errMsg);
      }
    } else {
      if (config.LOGIN_MODE === 'LOCAL_SYNC') {
        const errMsg = `State file ${config.STATE_FILE} is missing, and LOGIN_MODE is set to LOCAL_SYNC. Please manually generate and place the state.json file.`;
        logger.error(errMsg);
        throw new Error(errMsg);
      }
    }

    if (config.LOGIN_MODE === 'TERMINAL_QR' && !process.stdout.isTTY) {
      const errMsg = `[环境熔断] 当前配置为 TERMINAL_QR 模式，但检测到运行环境为非交互式终端（如 PM2 / systemd / Docker 后台）。用户无法看到控制台二维码，为防止无效的扫码等待与潜在的 IP 风控，已自动拦截并报错停止。请修改 LOGIN_MODE 配置（使用 LOCAL_SYNC 或 BOT_NOTIFY）或在交互式终端中重新运行以生成授权信息。`;
      logger.error(errMsg);
      throw new Error(errMsg);
    }

    // If we reach here, we need to perform QR login (either TERMINAL_QR or BOT_NOTIFY)
    logger.info(`Starting interactive QR login flow (Mode: ${config.LOGIN_MODE})...`);
    await this.performQrLogin(onSuccessNotify);
  }

  /**
   * Browserless simulated QR scan login flow.
   */
  private static async performQrLogin(onSuccessNotify?: string): Promise<void> {
    const jar = new CookieJar();

    // Helper request wrapper to maintain cookies, handle redirects manually, and save cookies at each step
    const request = async (url: string, options: any = {}) => {
      const { getAxiosProxyConfig } = require('../utils/proxyHelper');
      let targetUrl = url;
      let redirectsCount = 0;
      const maxRedirects = 10;
      let response;

      while (redirectsCount < maxRedirects) {
        if (targetUrl.startsWith('//')) {
          targetUrl = 'https:' + targetUrl;
        } else if (!targetUrl.startsWith('http://') && !targetUrl.startsWith('https://')) {
          targetUrl = 'https://login.sina.com.cn' + (targetUrl.startsWith('/') ? '' : '/') + targetUrl;
        }

        const headers = {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          'Referer': options.headers?.Referer || 'https://passport.weibo.com/sso/signin',
          'Cookie': jar.getCookieHeader(targetUrl),
          ...(options.headers || {})
        };

        const currentOptions = {
          ...options,
          url: targetUrl,
          headers,
          proxy: getAxiosProxyConfig(),
          maxRedirects: 0,
          validateStatus: (status: number) => status >= 200 && status < 400
        };

        response = await axios(currentOptions);

        const setCookie = response.headers['set-cookie'];
        if (setCookie) {
          jar.addCookies(setCookie, targetUrl);
        }

        if (response.status >= 300 && response.status < 400 && response.headers.location) {
          const redirectUrl = response.headers.location;
          const parsedUrl = new URL(targetUrl);
          const resolvedUrl = new URL(redirectUrl, parsedUrl.origin).toString();
          targetUrl = resolvedUrl;
          redirectsCount++;
          // Prepare options for the next GET request in the redirect chain
          options = {
            ...options,
            method: 'GET',
            data: undefined,
            headers: {
              ...options.headers,
              'Referer': currentOptions.url
            }
          };
          logger.debug(`手动重定向 [${redirectsCount}]: ${targetUrl}`);
        } else {
          break;
        }
      }

      return response!;
    };

    let tempQrPath: string | null = null;

    try {
      logger.info('正在请求新浪扫码登录接口以获取二维码...');
      const callbackName = `STK_${Date.now()}`;
      const qrRes = await request(`https://login.sina.com.cn/sso/qrcode/image?entry=miniblog&size=180&callback=${callbackName}`, {
        responseType: 'text'
      });

      const jsonMatch = qrRes.data.match(/\(([^)]+)\)/);
      if (!jsonMatch) {
        throw new Error(`获取二维码返回格式异常: ${qrRes.data}`);
      }
      const qrData = JSON.parse(jsonMatch[1]);
      if (qrData.retcode !== 20000000) {
        throw new Error(`获取二维码失败: ${JSON.stringify(qrData)}`);
      }

      const qrid = qrData.data.qrid;
      const qrImageUrl = qrData.data.image || `https://login.sina.com.cn/sso/qrcode/download?qrid=${qrid}`;
      logger.info(`成功获取 QR ID: ${qrid}`);

      logger.info('正在下载二维码图片以进行解析...');
      const imgRes = await request(qrImageUrl, {
        responseType: 'arraybuffer'
      });
      let screenshotBuffer = Buffer.from(imgRes.data);
      const iendIndex = screenshotBuffer.indexOf('IEND');
      if (iendIndex > -1) {
        screenshotBuffer = screenshotBuffer.subarray(0, iendIndex + 8);
      }

      logger.info('正在解析二维码文本...');
      let qrText = '';
      try {
        const png = PNG.sync.read(screenshotBuffer);
        const decoded = jsQR(new Uint8ClampedArray(png.data), png.width, png.height);
        if (decoded) {
          qrText = decoded.data;
          logger.info(`成功解析二维码内容 payload: ${qrText}`);
        } else {
          logger.warn('jsQR 未能在下载 of 的图片中识别出有效的二维码。');
        }
      } catch (err: any) {
        logger.error('解析二维码图片 Buffer 失败', err);
      }

      // Handle based on LOGIN_MODE
      if (config.LOGIN_MODE === 'TERMINAL_QR') {
        if (qrText) {
          logger.info('正在终端渲染二维码:');
          qrcodeTerminal.generate(qrText, { small: true }, (qrcode) => {
            console.log('\n' + qrcode + '\n');
          });
          console.log('>>> 请使用手机微博客户端扫描上方二维码以登录。 <<<');
        } else {
          logger.error('二维码未识别成功，无法展示字符画。');
        }
      } else if (config.LOGIN_MODE === 'BOT_NOTIFY') {
        tempQrPath = path.join(process.cwd(), 'logs', `qr_${Date.now()}.png`);
        const logsDir = path.dirname(tempQrPath);
        if (!fs.existsSync(logsDir)) {
          fs.mkdirSync(logsDir, { recursive: true });
        }
        fs.writeFileSync(tempQrPath, screenshotBuffer);

        logger.info(`二维码图片已保存至 ${tempQrPath}。正在发送机器人通知...`);
        let caption = '微博爬虫：请扫码确认登录。';
        if (qrText) {
          caption += `\n原始链接: ${qrText}`;
        }
        await Notifier.sendPhoto(tempQrPath, caption);
        console.log(`>>> 二维码已通过机器人发送。截图保存在 ${tempQrPath} <<<`);
      }

      logger.info('正在等待用户扫码授权（限时 2 分钟）...');
      let alt = '';
      const pollStartTime = Date.now();
      const timeoutMs = 120000;

      while (Date.now() - pollStartTime < timeoutMs) {
        const checkUrl = `https://login.sina.com.cn/sso/qrcode/check?entry=miniblog&qrid=${qrid}&callback=STK_${Date.now()}`;
        const checkRes = await request(checkUrl, {
          responseType: 'text'
        });

        // Parse JSONP response
        const jsonMatch = checkRes.data.match(/\(([^)]+)\)/);
        if (!jsonMatch) {
          logger.error(`轮询返回格式异常: ${checkRes.data}`);
          await new Promise(resolve => setTimeout(resolve, 2000));
          continue;
        }

        const checkData = JSON.parse(jsonMatch[1]);
        const retcode = checkData.retcode;

        if (retcode === 20000000) {
          alt = checkData.data.alt;
          logger.info('用户已扫码并确认登录！正在获取登录凭证...');
          break;
        } else if (retcode === 50114002) {
          logger.info('二维码已被扫描，等待手机端确认...');
        } else if (retcode === 50114001) {
          // Waiting for scan, normal
        } else if (retcode === 50114004) {
          throw new Error('二维码已过期，请重新运行程序。');
        } else {
          logger.debug(`未知的扫码轮询状态码: ${retcode} (${checkData.msg})`);
        }

        await new Promise(resolve => setTimeout(resolve, 2000));
      }

      if (!alt) {
        throw new Error('扫码登录超时或用户取消授权。');
      }

      logger.info('正在与 SSO 登录系统交换安全令牌并同步会话...');
      const loginUrl = `https://login.sina.com.cn/sso/login.php?entry=miniblog&crossdomain=1&gateway=1&savestate=7&alt=${alt}`;

      // Helper function to extract and visit ticket URLs from HTML scripts
      const extractAndVisitTickets = async (html: string) => {
        // Unescape escaped forward slashes (\/) typically found in JS arrays/JSON
        const cleanHtml = html.replace(/\\/g, '');
        const ticketRegex = /(?:https?:)?\/\/[a-zA-Z0-9.\-_]+\/[^'"\s>]*ticket=[^'"\s>]+/g;
        const matches = cleanHtml.match(ticketRegex);
        if (matches && matches.length > 0) {
          logger.info(`从 HTML 中提取到 ${matches.length} 个跨域授权 Ticket 链接，开始依次访问...`);
          for (let rawUrl of matches) {
            // Unescape HTML entities like &amp; to &
            rawUrl = rawUrl.replace(/&amp;/g, '&');
            let url = rawUrl;
            if (url.startsWith('//')) {
              url = 'https:' + url;
            }
            logger.info(`访问跨域授权链接: ${url}`);
            try {
              await request(url, {
                responseType: 'text',
                headers: {
                  'Referer': 'https://login.sina.com.cn/'
                }
              });
            } catch (err: any) {
              logger.warn(`跨域授权链接访问失败 (${url}): ${err.message}`);
            }
          }
        }
      };

      let loginRes = await request(loginUrl, {
        responseType: 'text',
        headers: {
          'Referer': 'https://passport.weibo.com/sso/signin'
        }
      });

      // 1. Visit any tickets in the initial login.php response
      if (typeof loginRes.data === 'string') {
        logger.info(`login.php 返回内容: ${loginRes.data}`);
        await extractAndVisitTickets(loginRes.data);
      }

      // 2. Parse JavaScript redirect if present (some responses return 200 OK with window.location.replace)
      const body = loginRes.data;
      if (typeof body === 'string') {
        const replaceMatch = body.match(/location\.replace\((['"])(.*?)\1\)/) || body.match(/location\.href\s*=\s*(['"])(.*?)\1/);
        if (replaceMatch && replaceMatch[2]) {
          const jsRedirectUrl = replaceMatch[2];
          logger.info(`检测到 JS 重定向 URL: ${jsRedirectUrl}`);
          loginRes = await request(jsRedirectUrl, {
            responseType: 'text',
            headers: {
              'Referer': loginUrl
            }
          });

          // Visit any tickets in the redirected response (e.g. crossdomain2.php)
          if (typeof loginRes.data === 'string') {
            logger.info(`crossdomain2.php 返回内容: ${loginRes.data}`);
            await extractAndVisitTickets(loginRes.data);
          }
        }
      }

      // Check if we obtained the SUB cookie on .weibo.com or .sina.com.cn
      let cookies = jar.getCookies();
      let subCookie = cookies.find(c => c.name === 'SUB');

      // If we only have SUB on .sina.com.cn but not on .weibo.com, copy it over
      const subSina = cookies.find(c => c.name === 'SUB' && c.domain.includes('sina.com.cn'));
      const subWeibo = cookies.find(c => c.name === 'SUB' && c.domain.includes('weibo.com'));
      if (subSina && !subWeibo) {
        logger.info('检测到 .sina.com.cn 域下的 SUB Cookie，自动复制该凭证至 .weibo.com 域下。');
        const expiresVal = subSina.expires ? `; expires=${new Date(subSina.expires * 1000).toUTCString()}` : '';
        jar.addCookie(`SUB=${subSina.value}; domain=.weibo.com; path=/${expiresVal}`, 'https://weibo.com/');
        // Refresh cookie list
        cookies = jar.getCookies();
        subCookie = cookies.find(c => c.name === 'SUB');
      }

      // Copy SUBP cookie if needed
      const subpSina = cookies.find(c => c.name === 'SUBP' && c.domain.includes('sina.com.cn'));
      const subpWeibo = cookies.find(c => c.name === 'SUBP' && c.domain.includes('weibo.com'));
      if (subpSina && !subpWeibo) {
        const expiresVal = subpSina.expires ? `; expires=${new Date(subpSina.expires * 1000).toUTCString()}` : '';
        jar.addCookie(`SUBP=${subpSina.value}; domain=.weibo.com; path=/${expiresVal}`, 'https://weibo.com/');
      }

      if (!subCookie) {
        throw new Error('跨域授权已执行，但未成功在 weibo.com 域下捕获到 SUB Cookie。');
      }

      // Save cookie state to local file
      jar.save(config.STATE_FILE);
      logger.info(`会话鉴权成功！状态已保存至 ${config.STATE_FILE}`);

      if (config.LOGIN_MODE === 'BOT_NOTIFY') {
        const notifyMsg = onSuccessNotify || "✅ 扫码登录成功！";
        await Notifier.sendText(notifyMsg);
      }

    } catch (error) {
      logger.error('模拟扫码登录流程出错:', error);
      throw error;
    } finally {
      if (tempQrPath && fs.existsSync(tempQrPath)) {
        try {
          fs.unlinkSync(tempQrPath);
          logger.debug(`已自动清理临时二维码图片文件: ${tempQrPath}`);
        } catch {}
      }
    }
  }

  /**
   * Helper to verify if the saved state is valid (non-expired cookies)
   */
  static async isSessionExpired(): Promise<boolean> {
    if (!fs.existsSync(config.STATE_FILE)) {
      return true;
    }

    try {
      const state = JSON.parse(fs.readFileSync(config.STATE_FILE, 'utf8'));
      const cookies = state.cookies || [];
      const subCookie = cookies.find((c: any) => c.name === 'SUB');

      if (!subCookie) return true;

      // 1. Offline expiration check
      if (subCookie.expires && subCookie.expires < Date.now() / 1000) {
        logger.warn('保存的 SUB Cookie 已在本地超时到期。');
        return true;
      }

      // 2. Online verification check
      logger.info('正在进行微博会话在线有效性校验...');
      const jar = new CookieJar();
      jar.load(config.STATE_FILE);
      const { getAxiosProxyConfig } = require('../utils/proxyHelper');
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
            'Cookie': jar.getCookieHeader(testUrl),
          },
          timeout: 10000,
        });

        const finalUrl = response.request?.res?.responseUrl || testUrl;
        const data = response.data;

        if (finalUrl.includes('passport.weibo.com') || finalUrl.includes('login.php')) {
          logger.warn('在线校验失败：会话已被新浪服务器注销或重定向至登录页。');
          return true;
        }

        if (data) {
          if (data.isLogin === false || data.ok === -100 || data.ok === 0) {
            logger.warn(`在线校验失败：接口返回未登录状态 (ok: ${data.ok}, isLogin: ${data.isLogin})。`);
            return true;
          }
          if (typeof data.url === 'string' && (data.url.includes('login.php') || data.url.includes('passport.weibo.com'))) {
            logger.warn(`在线校验失败：接口指示需登录 (跳转 URL: ${data.url})。`);
            return true;
          }
        }

        logger.info('在线校验成功：微博会话依然有效。');
        return false;
      } catch (err: any) {
        const status = err.response?.status;
        const finalUrl = err.response?.request?.res?.responseUrl || '';

        // If explicit login redirect or 401 Unauthorized, session is definitely expired
        if (status === 401 || finalUrl.includes('passport.weibo.com') || finalUrl.includes('login.php')) {
          logger.warn(`在线校验失败：服务器返回状态码 ${status || 'Redirect'}，会话已失效。`);
          return true;
        }

        // For 403 or other WAF/network errors, perform secondary fallback check on s.weibo.com
        logger.warn(`主校验接口 (ajax/config) 返回异常 [${status || err.message}]，正在尝试备用校验 (s.weibo.com)...`);
        try {
          const fallbackUrl = 'https://s.weibo.com/weibo?q=test';
          const fallbackRes = await axios({
            url: fallbackUrl,
            method: 'GET',
            proxy: getAxiosProxyConfig(),
            headers: {
              'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
              'Referer': 'https://s.weibo.com/',
              'Cookie': jar.getCookieHeader(fallbackUrl)
            },
            timeout: 10000
          });
          const fallbackFinalUrl = fallbackRes.request?.res?.responseUrl || fallbackUrl;
          const fallbackBody = typeof fallbackRes.data === 'string' ? fallbackRes.data : '';

          if (fallbackFinalUrl.includes('passport.weibo.com') || fallbackFinalUrl.includes('login.php') || fallbackBody.includes('retcode=6102') || fallbackBody.includes('location.replace')) {
            logger.warn('备用校验失败：页面被重定向至登录页或拦截。会话已失效。');
            return true;
          }
          logger.info('备用校验成功：s.weibo.com 可正常访问，判定会话有效。');
          return false;
        } catch (fallbackErr: any) {
          const fbStatus = fallbackErr.response?.status;
          const fbFinalUrl = fallbackErr.response?.request?.res?.responseUrl || '';
          if (fbStatus === 401 || fbFinalUrl.includes('passport.weibo.com') || fbFinalUrl.includes('login.php')) {
            logger.warn(`备用校验失败：服务器返回 ${fbStatus || 'Redirect'}。会话已失效。`);
            return true;
          }
        }

        // If network/WAF returned 403 or timeouts on both checks, but local SUB cookie is unexpired, default to trusting local credentials
        logger.warn(`在线验证受阻 (状态码 ${status || err.message})。鉴于本地 SUB Cookie 尚未过期，默认信任本地凭证继续运行...`);
        return false;
      }

    } catch (err: any) {
      logger.error('读取或解析 state.json 失败，判定为未登录状态', err);
      return true;
    }
  }
}
