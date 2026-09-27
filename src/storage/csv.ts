import * as fs from 'fs';
import * as path from 'path';
import { ParsedPost, ParsedComment } from '../scraper/parser';

/**
 * Escapes a field for CSV safety according to RFC 4180
 */
function escapeCsvField(val: any): string {
  if (val === null || val === undefined) return '';
  const str = String(val);
  // If the field contains comma, double-quote, or newline, wrap it in double-quotes and double the inner double-quotes.
  if (str.includes(',') || str.includes('"') || str.includes('\n') || str.includes('\r')) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

const csvPostIdsCache = new Map<string, Set<string>>();
const csvCommentIdsCache = new Map<string, Set<string>>();

function getCachedPostIds(csvPath: string): Set<string> {
  let ids = csvPostIdsCache.get(csvPath);
  if (!ids) {
    ids = new Set<string>();
    if (fs.existsSync(csvPath)) {
      try {
        const content = fs.readFileSync(csvPath, 'utf8');
        const lines = content.split('\n');
        for (let i = 1; i < lines.length; i++) {
          const line = lines[i].trim();
          if (!line) continue;
          const commaIdx = line.indexOf(',');
          const idCol = commaIdx !== -1 ? line.substring(0, commaIdx).replace(/^"|"$/g, '') : line;
          if (idCol) ids.add(idCol);
        }
      } catch {}
    }
    csvPostIdsCache.set(csvPath, ids);
  }
  return ids;
}

function getCachedCommentIds(csvPath: string): Set<string> {
  let ids = csvCommentIdsCache.get(csvPath);
  if (!ids) {
    ids = new Set<string>();
    if (fs.existsSync(csvPath)) {
      try {
        const content = fs.readFileSync(csvPath, 'utf8');
        const lines = content.split('\n');
        for (let i = 1; i < lines.length; i++) {
          const line = lines[i].trim();
          if (!line) continue;
          const commaIdx = line.indexOf(',');
          const firstCol = commaIdx !== -1 ? line.substring(0, commaIdx).replace(/^"|"$/g, '') : line;
          if (firstCol) ids.add(firstCol);
        }
      } catch {}
    }
    csvCommentIdsCache.set(csvPath, ids);
  }
  return ids;
}

export async function appendPostToCsv(post: ParsedPost, userDir: string, monthSubDir: string): Promise<void> {
  const dir = path.join(userDir, monthSubDir);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  const csvPath = path.join(dir, 'posts.csv');
  const fileExists = fs.existsSync(csvPath);

  const row = {
    id: post.id,
    time: post.time,
    content: post.content ? post.content.replace(/\r?\n/g, ' ') : '', // Strip internal newlines for easier CSV reading
    reposts_count: post.reposts_count,
    comments_count: post.comments_count,
    attitudes_count: post.attitudes_count,
    device: post.device,
    ip_location: post.ip_location,
    cdn_images: post.cdn_images.join(';'),
    local_images: post.local_images.join(';'),
    cdn_videos: post.cdn_videos.join(';'),
    local_videos: post.local_videos.join(';'),
    cdn_livephotos: post.cdn_livephotos.join(';'),
    local_livephotos: post.local_livephotos.join(';'),
    is_retweet: post.is_retweet ? 1 : 0,
    retweeted_id: post.retweeted_id || '',
    retweeted_user: post.retweeted_user || '',
    retweeted_content: post.retweeted_content ? post.retweeted_content.replace(/\r?\n/g, ' ') : ''
  };

  const headers = Object.keys(row).join(',') + '\n';
  const rowStr = Object.values(row).map(escapeCsvField).join(',') + '\n';

  const knownIds = getCachedPostIds(csvPath);

  // Upsert support: 仅当该微博已存在于 posts.csv 中时，才执行全量覆写更新；新微博直接走极速追加
  if (fileExists && knownIds.has(post.id)) {
    try {
      const content = fs.readFileSync(csvPath, 'utf8');
      const lines = content.split('\n');
      const header = lines[0];
      const dataLines = lines.slice(1);
      const updatedLines: string[] = [];

      for (const line of dataLines) {
        if (!line.trim()) continue;
        const commaIdx = line.indexOf(',');
        const idCol = commaIdx !== -1 ? line.substring(0, commaIdx).replace(/^"|"$/g, '') : line;
        if (idCol === post.id) {
          updatedLines.push(rowStr.trim());
        } else {
          updatedLines.push(line);
        }
      }

      fs.writeFileSync(csvPath, [header, ...updatedLines].join('\n') + '\n', 'utf8');
      return;
    } catch {}
  }

  // Ensure atomic file appending
  if (!fileExists) {
    fs.writeFileSync(csvPath, headers, 'utf8');
  }
  fs.appendFileSync(csvPath, rowStr, 'utf8');
  knownIds.add(post.id);
}

export async function appendCommentsToCsv(comments: ParsedComment[], userDir: string, monthSubDir: string): Promise<void> {
  if (!comments || comments.length === 0) return;

  const dir = path.join(userDir, monthSubDir);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  const csvPath = path.join(dir, 'comments.csv');
  const fileExists = fs.existsSync(csvPath);

  const sampleRow = {
    id: '',
    post_id: '',
    parent_id: '',
    time: '',
    content: '',
    user_id: '',
    user_name: '',
    ip_location: '',
    like_count: 0,
    cdn_image: '',
    local_image: ''
  };
  const headers = Object.keys(sampleRow).join(',') + '\n';

  // Deduplication using memory-cached comment IDs
  const existingCommentIds = getCachedCommentIds(csvPath);

  if (!fileExists) {
    fs.writeFileSync(csvPath, headers, 'utf8');
  }

  let appendData = '';
  for (const c of comments) {
    if (existingCommentIds.has(c.id)) continue;
    existingCommentIds.add(c.id);

    const row = {
      id: c.id,
      post_id: c.post_id,
      parent_id: c.parent_id || '',
      time: c.time,
      content: c.content ? c.content.replace(/\r?\n/g, ' ') : '',
      user_id: c.user_id,
      user_name: c.user_name,
      ip_location: c.ip_location,
      like_count: c.like_count,
      cdn_image: c.cdn_image || '',
      local_image: c.local_image || ''
    };
    appendData += Object.values(row).map(escapeCsvField).join(',') + '\n';
  }

  if (appendData) {
    fs.appendFileSync(csvPath, appendData, 'utf8');
  }
}
