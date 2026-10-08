import * as fs from 'fs';
import * as path from 'path';
import { logger } from './logger';

export interface WeiboCookie {
  name: string;
  value: string;
  domain: string;
  path: string;
  expires: number | null; // Unix timestamp in seconds, or null for Session Cookie
  httpOnly: boolean;
  secure: boolean;
  sameSite: 'Lax' | 'Strict' | 'None';
  hostOnly?: boolean;
}

/**
 * Checks whether cookie path matches request path according to RFC 6265.
 */
export function pathMatches(requestPath: string, cookiePath: string): boolean {
  let req = requestPath || '/';
  let cookie = cookiePath || '/';

  if (!req.startsWith('/')) req = '/' + req;
  if (!cookie.startsWith('/')) cookie = '/' + cookie;

  if (req === cookie) {
    return true;
  }

  if (req.startsWith(cookie)) {
    if (cookie.endsWith('/')) {
      return true;
    }
    if (req.charAt(cookie.length) === '/') {
      return true;
    }
  }

  return false;
}

/**
 * Checks whether request hostname matches cookie domain according to RFC 6265.
 */
export function domainMatches(hostname: string, cookieDomain: string, hostOnly: boolean): boolean {
  const host = hostname.toLowerCase();
  let cd = cookieDomain.toLowerCase();

  if (cd.startsWith('.')) {
    cd = cd.substring(1);
  }

  if (hostOnly) {
    return host === cd;
  }

  if (host === cd) {
    return true;
  }

  if (host.endsWith('.' + cd)) {
    return true;
  }

  return false;
}

/**
 * Checks if a cookie is expired. Session cookies (expires === null) are never expired locally.
 */
export function isCookieExpired(cookie: WeiboCookie, nowSec: number = Math.floor(Date.now() / 1000)): boolean {
  if (cookie.expires === null || cookie.expires === undefined) {
    return false; // Session cookie is valid for the lifetime of session
  }
  return typeof cookie.expires === 'number' && cookie.expires <= nowSec;
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
      const rawCookies: any[] = parsed.cookies || [];
      this.cookies = rawCookies.map(c => ({
        name: String(c.name || ''),
        value: String(c.value || ''),
        domain: String(c.domain || ''),
        path: String(c.path || '/'),
        expires: typeof c.expires === 'number' ? c.expires : null,
        httpOnly: Boolean(c.httpOnly),
        secure: Boolean(c.secure),
        sameSite: (c.sameSite === 'Strict' || c.sameSite === 'None') ? c.sameSite : 'Lax',
        hostOnly: c.hostOnly !== undefined ? Boolean(c.hostOnly) : (!String(c.domain || '').startsWith('.'))
      })).filter(c => c.name.length > 0);
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
    let hostOnly = true;
    let path = '/';
    let expires: number | null = null; // Session cookie by default (RFC 6265)
    let httpOnly = false;
    let secure = false;
    let sameSite: 'Lax' | 'Strict' | 'None' = 'Lax';

    let maxAgeParsed = false;

    for (let i = 1; i < parts.length; i++) {
      const part = parts[i];
      const eq = part.indexOf('=');
      const key = (eq > -1 ? part.substring(0, eq) : part).toLowerCase().trim();
      const val = eq > -1 ? part.substring(eq + 1).trim() : '';

      if (key === 'domain') {
        domain = val;
        hostOnly = false;
      } else if (key === 'path') {
        path = val.startsWith('/') ? val : '/' + val;
      } else if (key === 'max-age') {
        const maxAge = parseInt(val, 10);
        if (!isNaN(maxAge)) {
          expires = Math.floor(Date.now() / 1000) + maxAge;
          maxAgeParsed = true;
        }
      } else if (key === 'expires' && !maxAgeParsed) {
        const parsedEpoch = Date.parse(val);
        if (!isNaN(parsedEpoch)) {
          expires = Math.floor(parsedEpoch / 1000);
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
    if (!hostOnly) {
      if (!domain.startsWith('.')) {
        domain = '.' + domain.toLowerCase();
      } else {
        domain = domain.toLowerCase();
      }
    } else {
      domain = domain.toLowerCase();
    }

    const newCookie: WeiboCookie = {
      name,
      value,
      domain,
      path,
      expires,
      httpOnly,
      secure,
      sameSite,
      hostOnly
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

  addCookies(setCookieHeaders: string[] | string | undefined, requestUrl: string): number {
    if (!setCookieHeaders) return 0;
    const headers = Array.isArray(setCookieHeaders) ? setCookieHeaders : [setCookieHeaders];
    let count = 0;
    for (const header of headers) {
      if (header && typeof header === 'string') {
        this.addCookie(header, requestUrl);
        count++;
      }
    }
    return count;
  }

  getCookieHeader(targetUrl: string): string {
    const url = new URL(targetUrl);
    const hostname = url.hostname.toLowerCase();
    const reqPath = url.pathname || '/';
    const isHttps = url.protocol === 'https:';
    const nowSec = Math.floor(Date.now() / 1000);

    // Filter out truly expired cookies (keep session cookies where expires is null)
    this.cookies = this.cookies.filter(c => !isCookieExpired(c, nowSec));

    const matched = this.cookies.filter(c => {
      // 1. Secure check: secure cookies should only be sent over https
      if (c.secure && !isHttps) {
        return false;
      }

      // 2. Domain check
      const hostOnly = c.hostOnly ?? (!c.domain.startsWith('.'));
      if (!domainMatches(hostname, c.domain, hostOnly)) {
        return false;
      }

      // 3. Path check
      if (!pathMatches(reqPath, c.path || '/')) {
        return false;
      }

      return true;
    });

    return matched.map(c => `${c.name}=${c.value}`).join('; ');
  }

  getCookies(): WeiboCookie[] {
    const nowSec = Math.floor(Date.now() / 1000);
    this.cookies = this.cookies.filter(c => !isCookieExpired(c, nowSec));
    return [...this.cookies];
  }

  setCookies(cookies: WeiboCookie[]): void {
    this.cookies = [...cookies];
  }

  clear(): void {
    this.cookies = [];
  }
}
