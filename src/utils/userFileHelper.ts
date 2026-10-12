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

export function parseCursorToTimestamp(str: string): number {
  const trimmed = str.trim();
  if (!trimmed) return 0;
  if (/^\d{10,13}$/.test(trimmed)) {
    const num = parseInt(trimmed, 10);
    return trimmed.length === 10 ? num * 1000 : num;
  }
  const normalized = trimmed.replace(/\//g, '-');
  if (/^\d{4}-\d{2}-\d{2}$/.test(normalized)) {
    const ts = Date.parse(`${normalized}T00:00:00+08:00`);
    if (!isNaN(ts)) return ts;
  }
  if (/^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}(:\d{2})?$/.test(normalized)) {
    const iso = normalized.replace(' ', 'T');
    const fullIso = iso.split(':').length === 2 ? `${iso}:00` : iso;
    const ts = Date.parse(`${fullIso}+08:00`);
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

export function formatCursorDateStr(val?: string): string {
  if (!val) return '';
  const ts = parseCursorToTimestamp(val);
  if (ts > 0) {
    return getBeijingDateParts(ts).dateStr;
  }
  const normalized = val.trim().replace(/\//g, '-');
  if (/^\d{4}-\d{1,2}-\d{1,2}/.test(normalized)) {
    return normalized.substring(0, 10);
  }
  return '';
}

export function isDateOrTimestamp(val: string): boolean {
  const v = val.trim();
  if (!v) return false;
  // Matches YYYY-MM-DD, YYYY-MM-DDTHH:mm:ss, YYYY/MM/DD, or unix timestamp (10-13 digits)
  if (/^\d{4}[-/]\d{1,2}[-/]\d{1,2}/.test(v)) return true;
  if (/^\d{10,13}$/.test(v)) return true;
  return false;
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
      
      const parts = trimmed.split('|');
      if (parts.length >= 1) {
        let firstPart = parts[0].trim();
        let isCommented = false;
        if (firstPart.startsWith('#')) {
          isCommented = true;
          firstPart = firstPart.slice(1).trim();
        }
        
        // A valid UID must be numeric
        if (/^\d+$/.test(firstPart)) {
          const uid = firstPart;
          let name = '';
          let cursor = '';
          let endDate = '';

          if (parts.length === 2) {
            const secondPart = parts[1]?.trim() || '';
            if (isDateOrTimestamp(secondPart)) {
              cursor = secondPart;
            } else {
              name = secondPart;
            }
          } else if (parts.length === 3) {
            const p1 = parts[1]?.trim() || '';
            const p2 = parts[2]?.trim() || '';
            if (isDateOrTimestamp(p1) && isDateOrTimestamp(p2)) {
              cursor = p1;
              endDate = p2;
            } else if (isDateOrTimestamp(p1) && !p2) {
              cursor = p1;
            } else {
              name = p1;
              cursor = p2;
            }
          } else if (parts.length >= 4) {
            name = parts[1]?.trim() || '';
            cursor = parts[2]?.trim() || '';
            const p3 = parts[3]?.trim() || '';
            if (isDateOrTimestamp(p3)) {
              endDate = p3;
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
      if (!entry.name && entry.cursor && !entry.endDate) {
        // Omit empty name column to keep clean 'UID | cursor' format
        parts = [`${prefix}${entry.uid}`, entry.cursor];
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
