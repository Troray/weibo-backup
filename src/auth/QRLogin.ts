import * as fs from 'fs';
import * as path from 'path';
import axios from 'axios';
import { PNG } from 'pngjs';
import jsQR from 'jsqr';
import * as qrcodeTerminal from 'qrcode-terminal';
import { config } from '../config';
import { logger } from '../utils/logger';
import { Notifier } from '../utils/notifier';
import { CookieJar, WeiboCookie } from '../utils/cookieHelper';
import { getAxiosProxyConfig } from '../utils/proxyHelper';

export class QRLogin {
  /**
   * Browserless simulated QR scan login flow.
   * Returns newly obtained WeiboCookie array on success.
   */
  public static async login(onSuccessNotify?: string): Promise<WeiboCookie[]> {
    const jar = new CookieJar();
    let tempQrPath: string | null = null;

    // Helper request wrapper to maintain cookies, handle redirects manually, and save cookies at each step
    const request = async (url: string, options: any = {}) => {
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
          logger.debug(`[QRLogin] 手动重定向 [${redirectsCount}]: ${targetUrl}`);
        } else {
          break;
        }
      }

      return response!;
    };

    try {
      logger.info('[QRLogin] 正在请求新浪扫码登录接口以获取二维码...');
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
      logger.info(`[QRLogin] 成功获取 QR ID: ${qrid}`);

      logger.info('[QRLogin] 正在下载二维码图片以进行解析...');
      const imgRes = await request(qrImageUrl, {
        responseType: 'arraybuffer'
      });
      let screenshotBuffer = Buffer.from(imgRes.data);
      const iendIndex = screenshotBuffer.indexOf('IEND');
      if (iendIndex > -1) {
        screenshotBuffer = screenshotBuffer.subarray(0, iendIndex + 8);
      }

      logger.info('[QRLogin] 正在解析二维码文本...');
      let qrText = '';
      try {
        const png = PNG.sync.read(screenshotBuffer);
        const decoded = jsQR(new Uint8ClampedArray(png.data), png.width, png.height);
        if (decoded) {
          qrText = decoded.data;
          logger.info(`[QRLogin] 成功解析二维码内容 payload: ${qrText}`);
        } else {
          logger.warn('[QRLogin] jsQR 未能在下载的图片中识别出有效的二维码。');
        }
      } catch (err: any) {
        logger.error('[QRLogin] 解析二维码图片 Buffer 失败', err);
      }

      // Handle based on LOGIN_MODE
      if (config.LOGIN_MODE === 'TERMINAL_QR') {
        if (qrText) {
          logger.info('[QRLogin] 正在终端渲染二维码:');
          qrcodeTerminal.generate(qrText, { small: true }, (qrcode) => {
            console.log('\n' + qrcode + '\n');
          });
          console.log('>>> 请使用手机微博客户端扫描上方二维码以登录。 <<<');
        } else {
          logger.error('[QRLogin] 二维码未识别成功，无法展示字符画。');
        }
      } else if (config.LOGIN_MODE === 'BOT_NOTIFY') {
        tempQrPath = path.join(process.cwd(), 'logs', `qr_${Date.now()}.png`);
        const logsDir = path.dirname(tempQrPath);
        if (!fs.existsSync(logsDir)) {
          fs.mkdirSync(logsDir, { recursive: true });
        }
        fs.writeFileSync(tempQrPath, screenshotBuffer);

        logger.info(`[QRLogin] 二维码图片已保存至 ${tempQrPath}。正在发送机器人通知...`);
        let caption = '微博爬虫：请扫码确认登录。';
        if (qrText) {
          caption += `\n原始链接: ${qrText}`;
        }
        await Notifier.sendPhoto(tempQrPath, caption);
        console.log(`>>> 二维码已通过机器人发送。截图保存在 ${tempQrPath} <<<`);
      }

      logger.info('[QRLogin] 正在等待用户扫码授权（限时 2 分钟）...');
      let alt = '';
      const pollStartTime = Date.now();
      const timeoutMs = 120000;

      while (Date.now() - pollStartTime < timeoutMs) {
        const checkUrl = `https://login.sina.com.cn/sso/qrcode/check?entry=miniblog&qrid=${qrid}&callback=STK_${Date.now()}`;
        const checkRes = await request(checkUrl, {
          responseType: 'text'
        });

        const jsonMatch = checkRes.data.match(/\(([^)]+)\)/);
        if (!jsonMatch) {
          logger.error(`[QRLogin] 轮询返回格式异常: ${checkRes.data}`);
          await new Promise(resolve => setTimeout(resolve, 2000));
          continue;
        }

        const checkData = JSON.parse(jsonMatch[1]);
        const retcode = checkData.retcode;

        if (retcode === 20000000) {
          alt = checkData.data.alt;
          logger.info('[QRLogin] 用户已扫码并确认登录！正在获取登录凭证...');
          break;
        } else if (retcode === 50114002) {
          logger.info('[QRLogin] 二维码已被扫描，等待手机端确认...');
        } else if (retcode === 50114001) {
          // Waiting for scan, normal
        } else if (retcode === 50114004) {
          throw new Error('二维码已过期，请重新运行程序。');
        } else {
          logger.debug(`[QRLogin] 未知的扫码轮询状态码: ${retcode} (${checkData.msg})`);
        }

        await new Promise(resolve => setTimeout(resolve, 2000));
      }

      if (!alt) {
        throw new Error('扫码登录超时或用户取消授权。');
      }

      logger.info('[QRLogin] 正在与 SSO 登录系统交换安全令牌并同步会话...');
      const loginUrl = `https://login.sina.com.cn/sso/login.php?entry=miniblog&crossdomain=1&gateway=1&savestate=7&alt=${alt}`;

      const extractAndVisitTickets = async (html: string) => {
        const cleanHtml = html.replace(/\\/g, '');
        const ticketRegex = /(?:https?:)?\/\/[a-zA-Z0-9.\-_]+\/[^'"\s>]*ticket=[^'"\s>]+/g;
        const matches = cleanHtml.match(ticketRegex);
        if (matches && matches.length > 0) {
          logger.info(`[QRLogin] 从 HTML 中提取到 ${matches.length} 个跨域授权 Ticket 链接，开始依次访问...`);
          for (let rawUrl of matches) {
            rawUrl = rawUrl.replace(/&amp;/g, '&');
            let url = rawUrl;
            if (url.startsWith('//')) {
              url = 'https:' + url;
            }
            logger.debug(`[QRLogin] 访问跨域授权链接: ${url}`);
            try {
              await request(url, {
                responseType: 'text',
                headers: {
                  'Referer': 'https://login.sina.com.cn/'
                }
              });
            } catch (err: any) {
              logger.warn(`[QRLogin] 跨域授权链接访问失败 (${url}): ${err.message}`);
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
        await extractAndVisitTickets(loginRes.data);
      }

      // 2. Parse JavaScript redirect if present
      const body = loginRes.data;
      if (typeof body === 'string') {
        const replaceMatch = body.match(/location\.replace\((['"])(.*?)\1\)/) || body.match(/location\.href\s*=\s*(['"])(.*?)\1/);
        if (replaceMatch && replaceMatch[2]) {
          const jsRedirectUrl = replaceMatch[2];
          logger.info(`[QRLogin] 检测到 JS 重定向 URL: ${jsRedirectUrl}`);
          loginRes = await request(jsRedirectUrl, {
            responseType: 'text',
            headers: {
              'Referer': loginUrl
            }
          });

          if (typeof loginRes.data === 'string') {
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
        logger.info('[QRLogin] 检测到 .sina.com.cn 域下的 SUB Cookie，自动复制该凭证至 .weibo.com 域下。');
        const expiresVal = subSina.expires ? `; expires=${new Date(subSina.expires * 1000).toUTCString()}` : '';
        jar.addCookie(`SUB=${subSina.value}; domain=.weibo.com; path=/${expiresVal}`, 'https://weibo.com/');
        cookies = jar.getCookies();
        subCookie = cookies.find(c => c.name === 'SUB');
      }

      // Copy SUBP cookie if needed
      const subpSina = cookies.find(c => c.name === 'SUBP' && c.domain.includes('sina.com.cn'));
      const subpWeibo = cookies.find(c => c.name === 'SUBP' && c.domain.includes('weibo.com'));
      if (subpSina && !subpWeibo) {
        const expiresVal = subpSina.expires ? `; expires=${new Date(subpSina.expires * 1000).toUTCString()}` : '';
        jar.addCookie(`SUBP=${subpSina.value}; domain=.weibo.com; path=/${expiresVal}`, 'https://weibo.com/');
        cookies = jar.getCookies();
      }

      if (!subCookie) {
        throw new Error('跨域授权已执行，但未成功在 weibo.com 域下捕获到 SUB Cookie。');
      }

      if (config.LOGIN_MODE === 'BOT_NOTIFY') {
        const notifyMsg = onSuccessNotify || '✅ 扫码登录成功！';
        await Notifier.sendText(notifyMsg);
      }

      return jar.getCookies();

    } catch (error) {
      logger.error('[QRLogin] 模拟扫码登录流程出错:', error);
      throw error;
    } finally {
      if (tempQrPath && fs.existsSync(tempQrPath)) {
        try {
          fs.unlinkSync(tempQrPath);
          logger.debug(`[QRLogin] 已自动清理临时二维码图片文件: ${tempQrPath}`);
        } catch {}
      }
    }
  }
}
