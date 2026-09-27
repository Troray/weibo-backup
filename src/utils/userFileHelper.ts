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
          const name = parts[1]?.trim() || '';
          const cursor = parts[2]?.trim() || '';
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
      const parts = [
        `${prefix}${entry.uid}`,
        entry.name || '',
        entry.cursor || ''
      ];
      // Trim empty trailing parts to keep format clean
      while (parts.length > 1 && !parts[parts.length - 1]) {
        parts.pop();
      }
      return parts.join(' | ');
    });
    
    // Ensure final newline or keep as is
    fs.writeFileSync(filePath, lines.join('\n'), 'utf8');
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
