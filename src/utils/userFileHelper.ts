import * as fs from 'fs';
import * as path from 'path';
import { config } from '../config';
import { logger } from './logger';

export interface UserEntry {
  uid?: string;
  name?: string;
  cursor?: string;
  endDate?: string;
  isCommented?: boolean;
  rawLine?: string; // used for comments or blank lines that aren't parsed
}

export function getBeijingDateParts(input: Date | number) {
  const ts = typeof input === 'number' ? input : input.getTime();
  const beijingDate = new Date(ts + 8 * 3600 * 1000);
  const pad = (n: number) => String(n).padStart(2, '0');
  const year = beijingDate.getUTCFullYear();
  const month = pad(beijingDate.getUTCMonth() + 1);
  const day = pad(beijingDate.getUTCDate());
  const hours = pad(beijingDate.getUTCHours());
  const minutes = pad(beijingDate.getUTCMinutes());
  const seconds = pad(beijingDate.getUTCSeconds());
  return {
    year,
    month,
    day,
    hours,
    minutes,
    seconds,
    dateStr: `${year}-${month}-${day}`,
    minuteStr: `${year}-${month}-${day} ${hours}:${minutes}`,
    isoStr: `${year}-${month}-${day}T${hours}:${minutes}:${seconds}`
  };
}

export function getTodayString(): string {
  return getBeijingDateParts(Date.now()).dateStr;
}

export function formatToMinute(input: Date | number): string {
  return getBeijingDateParts(input).minuteStr;
}

export function parseCursorToTimestamp(str?: string | null): number {
  if (!str) return 0;
  const trimmed = str.trim();
  if (!trimmed) return 0;
  if (/^\d{10,13}$/.test(trimmed)) {
    const num = parseInt(trimmed, 10);
    return trimmed.length === 10 ? num * 1000 : num;
  }
  const normalized = trimmed.replace(/\//g, '-');
  const dateOnlyMatch = normalized.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (dateOnlyMatch) {
    const [, y, m, d] = dateOnlyMatch;
    const padded = `${y}-${m.padStart(2, '0')}-${d.padStart(2, '0')}`;
    const ts = Date.parse(`${padded}T00:00:00+08:00`);
    if (!isNaN(ts)) return ts;
  }
  const dateTimeMatch = normalized.match(/^(\d{4})-(\d{1,2})-(\d{1,2})[ T](\d{1,2}):(\d{2})(?::(\d{2}))?$/);
  if (dateTimeMatch) {
    const [, y, m, d, hh, mm, ss] = dateTimeMatch;
    const paddedDate = `${y}-${m.padStart(2, '0')}-${d.padStart(2, '0')}`;
    const paddedTime = `${hh.padStart(2, '0')}:${mm}:${ss ? ss.padStart(2, '0') : '00'}`;
    const ts = Date.parse(`${paddedDate}T${paddedTime}+08:00`);
    if (!isNaN(ts)) return ts;
  }
  const fallback = Date.parse(trimmed);
  return isNaN(fallback) ? 0 : fallback;
}

export function parseUidList(raw: string): string[] {
  if (!raw) return [];
  const cleaned = raw.trim().replace(/^\[\s*|\s*\]$/g, '');
  return cleaned
    .split(',')
    .map(s => s.trim().replace(/^['"]|['"]$/g, ''))
    .filter(s => /^\d+$/.test(s));
}

export function isUserListFile(): boolean {
  const list = config.USER_ID_LIST.trim().replace(/^['"]|['"]$/g, '');
  if (list.toLowerCase().endsWith('.txt')) return true;
  if (!list.includes(',')) {
    const candidate = path.isAbsolute(list) ? list : path.join(process.cwd(), list);
    try {
      if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
        return true;
      }
    } catch {}
  }
  return false;
}

export function getActiveUids(): string[] {
  if (isUserListFile()) {
    return readUsers().filter(u => !u.isCommented && u.uid).map(u => u.uid!);
  }
  return parseUidList(config.USER_ID_LIST);
}

export function getUserFilePath(): string {
  const list = config.USER_ID_LIST.trim().replace(/^['"]|['"]$/g, '');
  if (list.toLowerCase().endsWith('.txt')) {
    return path.isAbsolute(list) ? list : path.join(process.cwd(), list);
  }
  if (!list.includes(',')) {
    const candidate = path.isAbsolute(list) ? list : path.join(process.cwd(), list);
    try {
      if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
        return candidate;
      }
    } catch {}
  }
  return path.join(process.cwd(), 'userid.txt');
}

export function getBloggerDisplayName(uid: string): string {
  try {
    if (isUserListFile()) {
      const users = readUsers();
      const match = users.find(u => u.uid === uid);
      if (match?.name) {
        return `${match.name} (${uid})`;
      }
    }
  } catch {}
  return uid;
}

export function formatCursorDateStr(val?: string | null): string {
  if (!val) return '';
  const ts = parseCursorToTimestamp(val);
  if (ts > 0) {
    return getBeijingDateParts(ts).dateStr;
  }
  const normalized = val.trim().replace(/\//g, '-');
  const m = normalized.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (m) {
    return `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`;
  }
  return '';
}

export function isDateOrTimestamp(val: string): boolean {
  const v = val.trim();
  if (!v) return false;
  if (isStrictDateString(v)) return true;
  if (/^\d{10,13}$/.test(v)) {
    const num = parseInt(v, 10);
    const ts = v.length === 10 ? num * 1000 : num;
    const year = new Date(ts).getFullYear();
    return year >= 2000 && year <= 2100;
  }
  return false;
}

export function isStrictDateString(val: string): boolean {
  const v = val.trim();
  if (!v) return false;
  return /^\d{4}[-/]\d{1,2}[-/]\d{1,2}([ T]\d{1,2}:\d{2}(:\d{2})?(\.\d{1,3})?([+-]\d{2}:?\d{2}|Z)?)?$/i.test(v);
}

function combineDateTimeTokens(tokens: string[]): string[] {
  const combined: string[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const curr = tokens[i];
    const next = tokens[i + 1];
    if (
      /^\d{4}[-/]\d{1,2}[-/]\d{1,2}$/.test(curr) &&
      next &&
      /^\d{1,2}:\d{2}(:\d{2})?(\.\d{1,3})?([+-]\d{2}:?\d{2}|Z)?$/i.test(next)
    ) {
      combined.push(`${curr} ${next}`);
      i++;
    } else {
      combined.push(curr);
    }
  }
  return combined;
}

export function readUsers(): UserEntry[] {
  const filePath = getUserFilePath();
  if (!fs.existsSync(filePath)) {
    return [];
  }
  try {
    const content = fs.readFileSync(filePath, 'utf8');
    const lines = content.split(/\r?\n/);
    const entries: UserEntry[] = [];
    
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) {
        entries.push({ rawLine: '' });
        continue;
      }

      let isCommented = false;
      let workLine = trimmed;
      if (workLine.startsWith('#')) {
        isCommented = true;
        workLine = workLine.slice(1).trim();
      }

      // Check if it's pipe-separated
      if (workLine.includes('|')) {
        const parts = workLine.split('|').map(p => p.trim());
        // Clean trailing empty tokens caused by trailing pipe delimiters (e.g. "UID | 2025-01-01 | 2025-12-31 | ")
        while (parts.length > 1 && parts[parts.length - 1] === '') {
          parts.pop();
        }
        const firstPart = parts[0];

        // A valid UID must be numeric
        if (/^\d+$/.test(firstPart)) {
          const uid = firstPart;
          let name = '';
          let cursor = '';
          let endDate = '';

          if (parts.length === 2) {
            const secondPart = parts[1] || '';
            if (isStrictDateString(secondPart) || isDateOrTimestamp(secondPart)) {
              cursor = secondPart;
            } else {
              name = secondPart;
            }
          } else if (parts.length === 3) {
            const p1 = parts[1] || '';
            const p2 = parts[2] || '';
            if (isStrictDateString(p1) && isStrictDateString(p2)) {
              cursor = p1;
              endDate = p2;
            } else if (isStrictDateString(p1) && !p2) {
              cursor = p1;
            } else {
              name = p1;
              cursor = p2;
            }
          } else if (parts.length >= 4) {
            if (isStrictDateString(parts[1]) && isStrictDateString(parts[2])) {
              // Format: UID | cursor | endDate [| extra]
              cursor = parts[1];
              endDate = parts[2];
            } else {
              // Standard: UID | name | cursor | endDate
              name = parts[1] || '';
              cursor = parts[2] || '';
              const p3 = parts[3] || '';
              if (isDateOrTimestamp(p3)) {
                endDate = p3;
              }
            }
          }

          entries.push({ uid, name, cursor, endDate, isCommented });
          continue;
        }
      } else {
        // Whitespace-separated (single space, multiple spaces, tabs)
        const rawTokens = workLine.split(/\s+/).filter(Boolean);
        if (rawTokens.length > 0 && /^\d+$/.test(rawTokens[0])) {
          const uid = rawTokens[0];
          const combined = combineDateTimeTokens(rawTokens.slice(1));
          let name = '';
          let cursor = '';
          let endDate = '';

          if (combined.length === 0) {
            // Only UID, e.g.: 1234567890
          } else if (combined.length === 1) {
            // Either UID + cursor, or UID + nickname
            if (isStrictDateString(combined[0]) || isDateOrTimestamp(combined[0])) {
              cursor = combined[0];
            } else {
              name = combined[0];
            }
          } else if (combined.length === 2) {
            const c0 = combined[0];
            const c1 = combined[1];
            if (isStrictDateString(c0) && isStrictDateString(c1)) {
              // 1234567890 2025-01-01 2025-12-31
              cursor = c0;
              endDate = c1;
            } else if (isStrictDateString(c1) || isDateOrTimestamp(c1)) {
              // 1234567890 科技小侦探 2026-10-10 or 1234567890 888888 2026-10-10
              name = c0;
              cursor = c1;
            } else {
              // 1234567890 John Doe (name with spaces)
              name = `${c0} ${c1}`;
            }
          } else if (combined.length === 3) {
            const c0 = combined[0];
            const c1 = combined[1];
            const c2 = combined[2];
            if (
              (isStrictDateString(c1) || isDateOrTimestamp(c1)) &&
              (isStrictDateString(c2) || isDateOrTimestamp(c2))
            ) {
              // 1234567890 科技小侦探 2025-01-01 2025-12-31
              name = c0;
              cursor = c1;
              endDate = c2;
            } else if (isStrictDateString(c2) || isDateOrTimestamp(c2)) {
              // 1234567890 John Doe 2026-10-10
              name = `${c0} ${c1}`;
              cursor = c2;
            } else {
              name = combined.join(' ');
            }
          } else {
            // combined.length >= 4
            const last = combined[combined.length - 1];
            const secondLast = combined[combined.length - 2];
            if (
              (isStrictDateString(secondLast) || isDateOrTimestamp(secondLast)) &&
              (isStrictDateString(last) || isDateOrTimestamp(last))
            ) {
              name = combined.slice(0, -2).join(' ');
              cursor = secondLast;
              endDate = last;
            } else if (isStrictDateString(last) || isDateOrTimestamp(last)) {
              name = combined.slice(0, -1).join(' ');
              cursor = last;
            } else {
              name = combined.join(' ');
            }
          }

          entries.push({ uid, name, cursor, endDate, isCommented });
          continue;
        }
      }
      
      // Fallback: treat as raw line (like documentation/general comment lines)
      entries.push({ rawLine: line });
    }
    
    return entries;
  } catch (err) {
    logger.error(`Failed to read user file: ${filePath}`, err);
    return [];
  }
}

export function writeUsers(entries: UserEntry[]): void {
  const filePath = getUserFilePath();
  try {
    const lines = entries.map(entry => {
      if (entry.rawLine !== undefined) {
        return entry.rawLine;
      }
      const prefix = entry.isCommented ? '#' : '';
      let parts: string[];
      if (!entry.name && entry.cursor) {
        // Omit empty name column to keep clean format: 'UID | cursor' or 'UID | cursor | endDate'
        parts = [`${prefix}${entry.uid}`, entry.cursor];
        if (entry.endDate) {
          parts.push(entry.endDate);
        }
      } else {
        parts = [
          `${prefix}${entry.uid}`,
          entry.name || '',
          entry.cursor || ''
        ];
        if (entry.endDate) {
          parts.push(entry.endDate);
        }
        // Trim empty trailing parts to keep format clean
        while (parts.length > 1 && !parts[parts.length - 1]) {
          parts.pop();
        }
      }
      return parts.join(' | ');
    });
    
    const tmpPath = `${filePath}.tmp`;
    fs.writeFileSync(tmpPath, lines.join('\n'), 'utf8');
    try {
      fs.renameSync(tmpPath, filePath);
    } catch {
      fs.copyFileSync(tmpPath, filePath);
      fs.unlinkSync(tmpPath);
    }
  } catch (err) {
    logger.error(`Failed to write user file: ${filePath}`, err);
  }
}

export function addUser(uid: string, name: string): void {
  const users = readUsers();
  const existingIndex = users.findIndex(u => u.uid === uid);
  if (existingIndex !== -1) {
    users[existingIndex].name = name;
    users[existingIndex].isCommented = false; // enable if commented out
  } else {
    // Add new user entry, default cursor is empty
    users.push({ uid, name, cursor: '', isCommented: false });
  }
  writeUsers(users);
}

export function deleteUser(uid: string): boolean {
  const users = readUsers();
  const initialLength = users.length;
  const filteredUsers = users.filter(u => u.uid !== uid);
  if (filteredUsers.length < initialLength) {
    writeUsers(filteredUsers);
    return true;
  }
  return false;
}

export function commentUser(uid: string, comment: boolean): boolean {
  const users = readUsers();
  const user = users.find(u => u.uid === uid);
  if (user) {
    user.isCommented = comment;
    writeUsers(users);
    return true;
  }
  return false;
}

export function setUserCursor(uid: string, dateStr: string): boolean {
  const users = readUsers();
  const user = users.find(u => u.uid === uid);
  if (user) {
    user.cursor = dateStr;
    writeUsers(users);
    return true;
  }
  return false;
}

export function setUserEndDate(uid: string, dateStr: string): boolean {
  const users = readUsers();
  const user = users.find(u => u.uid === uid);
  if (user) {
    user.endDate = dateStr.trim();
    writeUsers(users);
    return true;
  }
  return false;
}

export interface CrawlModeSummary {
  modeDesc: string;
  usersDesc: string;
  bloggerStats: string;
  activeCount: number;
  totalCount: number;
}

export function getCrawlModeSummary(): CrawlModeSummary {
  const list = config.USER_ID_LIST.trim();
  const isFile = isUserListFile();

  let activeUsers: { uid: string; name?: string; cursorDate?: string; endDate?: string }[] = [];
  let totalCount = 0;

  if (isFile) {
    const all = readUsers();
    totalCount = all.filter(u => u.uid).length;
    const active = all.filter(u => !u.isCommented && u.uid);
    activeUsers = active.map(u => ({
      uid: u.uid!,
      name: u.name,
      cursorDate: formatCursorDateStr(u.cursor),
      endDate: formatCursorDateStr(u.endDate)
    }));
  } else {
    const uids = parseUidList(list);
    totalCount = uids.length;
    activeUsers = uids.map(uid => ({ uid }));
  }

  const activeCount = activeUsers.length;
  const globalEnd = config.END_DATE || '今天';

  if (activeCount === 0) {
    return {
      modeDesc: config.START_DATE ? `日期区间 (${config.START_DATE} ~ ${globalEnd})` : '主页增量 Feed',
      usersDesc: '未配置有效博主',
      bloggerStats: isFile ? `0 位 / 共 ${totalCount} 位` : '0 位',
      activeCount: 0,
      totalCount
    };
  }

  // 1. Build usersDesc
  let usersDesc = '';
  if (activeCount === 1) {
    const u = activeUsers[0];
    const nameStr = u.name ? `${u.name} (${u.uid})` : u.uid;
    const startStr = u.cursorDate || config.START_DATE;
    const endStr = u.endDate;
    let rangeTag = '';
    if (startStr && endStr) {
      rangeTag = ` [${startStr} ~ ${endStr}]`;
    } else if (startStr) {
      rangeTag = ` [自 ${startStr}]`;
    } else if (endStr) {
      rangeTag = ` [至 ${endStr}]`;
    }
    usersDesc = `共 1 位 (${nameStr}${rangeTag})`;
  } else {
    const items = activeUsers.map(u => {
      const name = u.name || u.uid;
      const startStr = u.cursorDate || (config.START_DATE ? `全局 ${config.START_DATE}` : '');
      const endStr = u.endDate;
      let rangeTag = '';
      if (startStr && endStr) {
        rangeTag = ` [${startStr} ~ ${endStr}]`;
      } else if (startStr) {
        rangeTag = ` [自 ${startStr}]`;
      } else if (endStr) {
        rangeTag = ` [至 ${endStr}]`;
      }
      return `${name}${rangeTag}`;
    });
    usersDesc = `共 ${activeCount} 位 (${items.join(', ')})`;
  }

  // 2. Build modeDesc
  const userModes = activeUsers.map(u => {
    const hasCursor = !!u.cursorDate;
    const effectiveStart = u.cursorDate || config.START_DATE || null;
    const effectiveEnd = u.endDate || globalEnd;
    return {
      hasCursor,
      effectiveStart,
      effectiveEnd,
      isDateMode: !!effectiveStart
    };
  });

  const allHaveCursor = userModes.every(m => m.hasCursor);
  const anyHasCursor = userModes.some(m => m.hasCursor);
  const allDateMode = userModes.every(m => m.isDateMode);

  let modeDesc = '';
  if (activeCount === 1) {
    const m = userModes[0];
    if (m.hasCursor) {
      modeDesc = `游标增量 (${m.effectiveStart} ~ ${m.effectiveEnd})`;
    } else if (m.effectiveStart) {
      modeDesc = `日期区间 (${m.effectiveStart} ~ ${m.effectiveEnd})`;
    } else {
      modeDesc = '主页增量 Feed';
    }
  } else if (allHaveCursor) {
    const firstStart = userModes[0].effectiveStart;
    const firstEnd = userModes[0].effectiveEnd;
    const allSameStart = userModes.every(m => m.effectiveStart === firstStart);
    const allSameEnd = userModes.every(m => m.effectiveEnd === firstEnd);
    if (allSameStart && allSameEnd) {
      modeDesc = `游标增量 (${firstStart} ~ ${firstEnd})`;
    } else {
      modeDesc = `独立游标增量 (各博主自定区间 ~ ${globalEnd})`;
    }
  } else if (anyHasCursor) {
    const fallbackDesc = config.START_DATE ? `START_DATE (${config.START_DATE})` : '主页 Feed';
    modeDesc = `混合模式 (有游标按游标增量，其余走 ${fallbackDesc} ~ ${globalEnd})`;
  } else if (allDateMode) {
    modeDesc = `日期区间 (${config.START_DATE} ~ ${globalEnd})`;
  } else {
    modeDesc = '主页增量 Feed';
  }

  const bloggerStats = isFile 
    ? `已启用 ${activeCount} 位 / 共 ${totalCount} 位`
    : `已配置 ${activeCount} 位`;

  return {
    modeDesc,
    usersDesc,
    bloggerStats,
    activeCount,
    totalCount
  };
}
