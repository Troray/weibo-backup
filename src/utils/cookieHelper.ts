import * as fs from 'fs';
import * as path from 'path';
import { logger } from './logger';

export interface WeiboCookie {
  name: string;
  value: string;
  domain: string;
  path: string;
  expires: number; // Unix timestamp in seconds
  httpOnly: boolean;
  secure: boolean;
  sameSite: 'Lax' | 'Strict' | 'None';
}

export class CookieJar {
  private cookies: WeiboCookie[] = [];

  constructor(stateFilePath?: string) {
    if (stateFilePath) {
      this.load(stateFilePath);
    }
  }

  load(stateFilePath: string): void {
    if (!fs.existsSync(stateFilePath)) {
      this.cookies = [];
      return;
    }
    try {
      const content = fs.readFileSync(stateFilePath, 'utf8');
      const parsed = JSON.parse(content);
      this.cookies = parsed.cookies || [];
    } catch (err: any) {
      logger.error(`读取 state.json 失败: ${err.message}`);
      this.cookies = [];
    }
  }

  save(stateFilePath: string): void {
    try {
      const dir = path.dirname(stateFilePath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      fs.writeFileSync(
        stateFilePath,
        JSON.stringify({ cookies: this.cookies, origins: [] }, null, 2),
        'utf8'
      );
    } catch (err: any) {
      logger.error(`保存 state.json 失败: ${err.message}`);
    }
  }

  addCookie(cookieStr: string, requestUrl: string): void {
    const parts = cookieStr.split(';').map(p => p.trim());
    if (parts.length === 0 || !parts[0]) return;

    const nameValuePair = parts[0];
    const eqIdx = nameValuePair.indexOf('=');
    if (eqIdx === -1) return;
    const name = nameValuePair.substring(0, eqIdx).trim();
    const value = nameValuePair.substring(eqIdx + 1).trim();

    const url = new URL(requestUrl);
    let domain = url.hostname;
    let path = '/';
    let expires = Math.floor(Date.now() / 1000) + 365 * 24 * 3600; // default 1 year
    let httpOnly = false;
    let secure = false;
    let sameSite: 'Lax' | 'Strict' | 'None' = 'Lax';

    for (let i = 1; i < parts.length; i++) {
      const part = parts[i];
      const eq = part.indexOf('=');
      const key = (eq > -1 ? part.substring(0, eq) : part).toLowerCase().trim();
      const val = eq > -1 ? part.substring(eq + 1).trim() : '';

      if (key === 'domain') {
        domain = val;
      } else if (key === 'path') {
        path = val;
      } else if (key === 'expires') {
        const parsedEpoch = Date.parse(val);
        if (!isNaN(parsedEpoch)) {
          expires = Math.floor(parsedEpoch / 1000);
        }
      } else if (key === 'max-age') {
        const maxAge = parseInt(val, 10);
        if (!isNaN(maxAge)) {
          expires = Math.floor(Date.now() / 1000) + maxAge;
        }
      } else if (key === 'httponly') {
        httpOnly = true;
      } else if (key === 'secure') {
        secure = true;
      } else if (key === 'samesite') {
        const lowerVal = val.toLowerCase();
        if (lowerVal === 'strict') sameSite = 'Strict';
        else if (lowerVal === 'none') sameSite = 'None';
        else sameSite = 'Lax';
      }
    }

    // Normalise domain
    if (domain.startsWith('.')) {
      // already wildcard domain
    } else if (domain !== url.hostname) {
      domain = '.' + domain;
    }

    const newCookie: WeiboCookie = {
      name,
      value,
      domain,
      path,
      expires,
      httpOnly,
      secure,
      sameSite
    };

    // Upsert cookie in jar (match by name, domain, path)
    const existingIdx = this.cookies.findIndex(
      c => c.name === name && c.domain.toLowerCase() === domain.toLowerCase() && c.path === path
    );
    if (existingIdx > -1) {
      this.cookies[existingIdx] = newCookie;
    } else {
      this.cookies.push(newCookie);
    }
  }

  addCookies(setCookieHeaders: string[] | string | undefined, requestUrl: string): void {
    if (!setCookieHeaders) return;
    const headers = Array.isArray(setCookieHeaders) ? setCookieHeaders : [setCookieHeaders];
    for (const header of headers) {
      this.addCookie(header, requestUrl);
    }
  }

  getCookieHeader(targetUrl: string): string {
    const url = new URL(targetUrl);
    const hostname = url.hostname.toLowerCase();
    const nowSec = Math.floor(Date.now() / 1000);

    // Filter expired cookies
    this.cookies = this.cookies.filter(c => c.expires > nowSec);

    const matched = this.cookies.filter(c => {
      const cookieDomain = c.domain.toLowerCase();
      if (cookieDomain === hostname) return true;
      if (cookieDomain.startsWith('.')) {
        const baseDomain = cookieDomain.substring(1);
        return hostname === baseDomain || hostname.endsWith('.' + baseDomain);
      }
      return false;
    });

    return matched.map(c => `${c.name}=${c.value}`).join('; ');
  }

  getCookies(): WeiboCookie[] {
    const nowSec = Math.floor(Date.now() / 1000);
    this.cookies = this.cookies.filter(c => c.expires > nowSec);
    return this.cookies;
  }
}
