import * as fs from 'fs';
import * as path from 'path';
import { config } from '../config';
import { logger } from './logger';

export interface UserEntry {
  uid?: string;
  name?: string;
  cursor?: string;
  isCommented?: boolean;
  rawLine?: string; // used for comments or blank lines that aren't parsed
}

export function getUserFilePath(): string {
  const list = config.USER_ID_LIST.trim();
  if (list.toLowerCase().endsWith('.txt')) {
    return path.isAbsolute(list) ? list : path.join(process.cwd(), list);
  }
  return path.join(process.cwd(), 'userid.txt');
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

          if (parts.length === 2) {
            const secondPart = parts[1]?.trim() || '';
            if (isDateOrTimestamp(secondPart)) {
              cursor = secondPart;
            } else {
              name = secondPart;
            }
          } else if (parts.length >= 3) {
            const p1 = parts[1]?.trim() || '';
            const p2 = parts[2]?.trim() || '';
            if (isDateOrTimestamp(p1) && !p2) {
              cursor = p1;
            } else {
              name = p1;
              cursor = p2;
            }
          }

          entries.push({ uid, name, cursor, isCommented });
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
        // Omit empty name column to keep clean 'UID | cursor' format
        parts = [`${prefix}${entry.uid}`, entry.cursor];
      } else {
        parts = [
          `${prefix}${entry.uid}`,
          entry.name || '',
          entry.cursor || ''
        ];
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
