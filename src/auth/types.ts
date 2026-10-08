import { WeiboCookie } from '../utils/cookieHelper';

export class SessionExpiredError extends Error {
  constructor(message: string = '微博登录会话已过期或已被注销') {
    super(message);
    this.name = 'SessionExpiredError';
    Object.setPrototypeOf(this, SessionExpiredError.prototype);
  }
}

export class NetworkError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NetworkError';
    Object.setPrototypeOf(this, NetworkError.prototype);
  }
}

export class RateLimitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RateLimitError';
    Object.setPrototypeOf(this, RateLimitError.prototype);
  }
}

export interface SessionMetadata {
  createdAt: number;
  lastValidatedAt: number;
  lastRefreshAt: number;
  lastCookieUpdateAt: number;
  uid?: string;
  screenName?: string;
}

export interface SessionStateV2 {
  version: 2;
  cookies: WeiboCookie[];
  session: SessionMetadata;
  origins?: any[];
}
