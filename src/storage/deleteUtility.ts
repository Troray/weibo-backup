import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { config } from '../config';
import { logger } from '../utils/logger';
import { getDb } from './db';
import { resolveMid } from '../utils/base62';

/**
 * Standard RFC 4180 CSV line parser
 */
function parseCsvLine(line: string): string[] {
  const result: string[] = [];
  let current = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    if (char === '"') {
      if (inQuotes && line[i + 1] === '"') {
        current += '"';
        i++;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (char === ',' && !inQuotes) {
      result.push(current);
      current = '';
    } else {
      current += char;
    }
  }
  result.push(current);
  return result;
}

/**
 * Safely parse array, JSON string, or delimiter-separated string into a list of strings
 */
function parseMediaList(val: any): string[] {
  if (!val) return [];
  if (Array.isArray(val)) return val.filter(Boolean).map(String);
  if (typeof val === 'string') {
    const trimmed = val.trim();
    if (!trimmed) return [];
    if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
      try {
        const parsed = JSON.parse(trimmed);
        if (Array.isArray(parsed)) return parsed.filter(Boolean).map(String);
      } catch {}
    }
    return trimmed.split(/[;,]/).map(s => s.trim()).filter(Boolean);
  }
  return [];
}

/**
 * Derives local media filename from CDN URL using the same logic as MediaDownloader
 */
function getFilenameFromUrl(urlStr: string, defaultExt: string): string {
  if (!urlStr || typeof urlStr !== 'string') return '';
  try {
    const parsed = new URL(urlStr);
    let filename = path.basename(parsed.pathname);
    if (filename.includes('?')) {
      filename = filename.split('?')[0];
    }
    if (!filename || !filename.includes('.')) {
      const hash = crypto.createHash('md5').update(urlStr).digest('hex').substring(0, 10);
      filename = `${hash}${defaultExt}`;
    }
    return filename;
  } catch {
    const hash = crypto.createHash('md5').update(urlStr).digest('hex').substring(0, 10);
    return `${hash}${defaultExt}`;
  }
}

/**
 * Deletes a media file by checking all potential candidate paths across userDir, monthDir, and media subfolders.
 * Accepts both local relative paths, filenames, and CDN URLs.
 */
function deleteMediaCandidates(userDir: string, monthDir: string, fileRef: string): boolean {
  if (!fileRef || typeof fileRef !== 'string') return false;
  let trimmed = fileRef.trim();
  if (!trimmed) return false;

  // If fileRef is a full URL (CDN URL), extract the filename
  if (trimmed.startsWith('http://') || trimmed.startsWith('https://')) {
    const ext = trimmed.includes('.mp4') ? '.mp4' : trimmed.includes('.mov') ? '.mov' : trimmed.includes('.aac') ? '.aac' : trimmed.includes('.mp3') ? '.mp3' : '.jpg';
    const filename = getFilenameFromUrl(trimmed, ext);
    if (!filename) return false;
    trimmed = filename;
  }

  const candidates: string[] = [];
  if (path.isAbsolute(trimmed)) {
    candidates.push(trimmed);
  }

  // Normalize all slashes to forward slashes first and strip leading slash
  const normalized = trimmed.replace(/\\/g, '/').replace(/^\/+/, '');
  const basename = path.basename(normalized);

  if (userDir) {
    candidates.push(path.join(userDir, normalized));
    candidates.push(path.join(userDir, basename));
    candidates.push(path.join(userDir, 'img', basename));
    candidates.push(path.join(userDir, 'comment_img', basename));
    candidates.push(path.join(userDir, 'video', basename));
    candidates.push(path.join(userDir, 'livephoto', basename));
    candidates.push(path.join(userDir, 'audio', basename));
  }

  if (monthDir) {
    candidates.push(path.join(monthDir, normalized));
    candidates.push(path.join(monthDir, basename));
    candidates.push(path.join(monthDir, 'img', basename));
    candidates.push(path.join(monthDir, 'comment_img', basename));
    candidates.push(path.join(monthDir, 'video', basename));
    candidates.push(path.join(monthDir, 'livephoto', basename));
    candidates.push(path.join(monthDir, 'audio', basename));
  }

  const safeRoot = path.resolve(config.OUTPUT_DIR);
  const unique = Array.from(new Set(candidates));
  let deleted = false;
  for (const candidate of unique) {
    const resolvedPath = path.resolve(candidate);

    // 安全边界检查：确保待删除文件绝对在 OUTPUT_DIR 内部，防范路径遍历与任意文件删除
    if (!resolvedPath.startsWith(safeRoot + path.sep)) {
      logger.warn(`[安全拦截] 忽略跳出输出目录的潜在危险文件路径: ${candidate}`);
      continue;
    }

    if (fs.existsSync(resolvedPath)) {
      try {
        fs.unlinkSync(resolvedPath);
        logger.info(`已成功物理删除媒体文件: ${resolvedPath}`);
        deleted = true;
      } catch (err: any) {
        logger.error(`删除媒体文件 ${resolvedPath} 失败: ${err.message}`);
      }
    }
  }
  return deleted;
}

/**
 * Clean directory if empty
 */
function cleanEmptyDir(dirPath: string): void {
  try {
    const resolvedDir = path.resolve(dirPath);
    const safeRoot = path.resolve(config.OUTPUT_DIR);
    if (!resolvedDir.startsWith(safeRoot + path.sep)) {
      return;
    }
    if (fs.existsSync(resolvedDir) && fs.readdirSync(resolvedDir).length === 0) {
      fs.rmdirSync(resolvedDir);
      logger.debug(`已清理空目录: ${resolvedDir}`);
    }
  } catch {}
}

/**
 * Clean empty media folders and month folders
 */
function cleanEmptyDirs(userDir?: string | null, monthDir?: string | null): void {
  const subdirs = ['img', 'comment_img', 'video', 'livephoto', 'json'];
  if (monthDir && fs.existsSync(monthDir)) {
    for (const sub of subdirs) {
      cleanEmptyDir(path.join(monthDir, sub));
    }
    cleanEmptyDir(monthDir);
  }
  if (userDir && fs.existsSync(userDir)) {
    for (const sub of subdirs) {
      cleanEmptyDir(path.join(userDir, sub));
    }
    cleanEmptyDir(userDir);
  }
}

interface DeleteMetadata {
  mid: string;
  uid: string;
  userName: string;
  postTime: string; // ISO string
  localImages: string[];
  localVideos: string[];
  localLivephotos: string[];
  cdnImages?: string[];
  cdnVideos?: string[];
  cdnLivephotos?: string[];
  commentLocalImages: string[];
  commentCdnImages?: string[];
  jsonPath?: string;
}

/**
 * Scan output directory to find post metadata by MID
 */
function scanOutputFolderForPost(mid: string): DeleteMetadata | null {
  const outputDir = config.OUTPUT_DIR;
  if (!fs.existsSync(outputDir)) return null;

  const bloggers = fs.readdirSync(outputDir);
  for (const blogger of bloggers) {
    const bloggerPath = path.join(outputDir, blogger);
    if (!fs.statSync(bloggerPath).isDirectory()) continue;

    const months = fs.readdirSync(bloggerPath);
    for (const month of months) {
      const monthPath = path.join(bloggerPath, month);
      if (!fs.statSync(monthPath).isDirectory()) continue;

      const jsonDir = path.join(monthPath, 'json');
      if (fs.existsSync(jsonDir)) {
        const jsonFiles = fs.readdirSync(jsonDir).filter(f => f.endsWith('.json'));
        for (const jsonFile of jsonFiles) {
          const jsonPath = path.join(jsonDir, jsonFile);
          try {
            const content = fs.readFileSync(jsonPath, 'utf8');
            const posts = JSON.parse(content);
            if (!Array.isArray(posts)) continue;

            const item = posts.find(p => p?.post?.id === mid);
            if (item) {
              const comments = item.comments || [];
              const commentLocalImages = comments
                .map((c: any) => c.local_image)
                .filter(Boolean);
              const commentCdnImages = comments
                .map((c: any) => c.cdn_image || c.image_url)
                .filter(Boolean);

              return {
                mid: item.post.id,
                uid: item.post.user_id || '',
                userName: blogger,
                postTime: item.post.time,
                localImages: parseMediaList(item.post.local_images),
                localVideos: parseMediaList(item.post.local_videos),
                localLivephotos: parseMediaList(item.post.local_livephotos),
                cdnImages: parseMediaList(item.post.cdn_images || item.post.original_pictures),
                cdnVideos: parseMediaList(item.post.cdn_videos || item.post.video_url),
                cdnLivephotos: parseMediaList(item.post.cdn_livephotos || item.post.livephotos),
                commentLocalImages,
                commentCdnImages,
                jsonPath
              };
            }
          } catch (err: any) {
            logger.warn(`扫描期间解析 json 文件 ${jsonPath} 失败: ${err.message}`);
          }
        }
      }

      // Also check posts.csv if not found in JSON
      const postsCsv = path.join(monthPath, 'posts.csv');
      if (fs.existsSync(postsCsv)) {
        try {
          const lines = fs.readFileSync(postsCsv, 'utf8').split('\n');
          for (let i = 1; i < lines.length; i++) {
            const line = lines[i].trim();
            if (!line) continue;
            const cols = parseCsvLine(line);
            if (cols[0] === mid) {
              return {
                mid,
                uid: '',
                userName: blogger,
                postTime: cols[1] || `${month}-01T00:00:00.000Z`,
                localImages: parseMediaList(cols[9]),
                localVideos: parseMediaList(cols[11]),
                localLivephotos: parseMediaList(cols[13]),
                cdnImages: parseMediaList(cols[8]),
                cdnVideos: parseMediaList(cols[10]),
                cdnLivephotos: parseMediaList(cols[12]),
                commentLocalImages: [],
                commentCdnImages: []
              };
            }
          }
        } catch {}
      }
    }
  }

  return null;
}

/**
 * Completely deletes a post and all associated local files, comments, and entries
 */
export async function deletePostData(urlOrBidOrMid: string): Promise<{ success: boolean; message: string }> {
  let mid = "";
  try {
    mid = resolveMid(urlOrBidOrMid);
  } catch (err: any) {
    return { success: false, message: `Invalid input: ${err.message}` };
  }

  logger.info(`正在对微博 MID: ${mid} 初始化删除流程...`);

  let metadata: DeleteMetadata | null = null;

  // 1. Try to fetch metadata from DB first
  if (config.DB_TYPE) {
    try {
      const db = getDb();
      const postRow = await db('posts').where({ id: mid }).first();
      if (postRow) {
        const commentRows = await db('comments').where({ post_id: mid }).select('local_image', 'cdn_image');
        const commentLocalImages = commentRows
          .map(c => c.local_image)
          .filter(Boolean);
        const commentCdnImages = commentRows
          .map(c => c.cdn_image)
          .filter(Boolean);

        metadata = {
          mid,
          uid: postRow.user_id || '',
          userName: postRow.user_name || '',
          postTime: postRow.time,
          localImages: parseMediaList(postRow.local_images),
          localVideos: parseMediaList(postRow.local_videos),
          localLivephotos: parseMediaList(postRow.local_livephotos),
          cdnImages: parseMediaList(postRow.cdn_images),
          cdnVideos: parseMediaList(postRow.cdn_videos),
          cdnLivephotos: parseMediaList(postRow.cdn_livephotos),
          commentLocalImages,
          commentCdnImages
        };
        logger.info(`已从数据库中检索到 MID ${mid} 的删除元数据。`);
      }
    } catch (err: any) {
      logger.warn(`从数据库检索微博详情失败: ${err.message}`);
    }
  }

  // 2. If not found in DB or DB not configured, scan local JSON files as fallback
  if (!metadata) {
    logger.info(`数据库中未找到该微博或已禁用数据库。正在扫描本地文件以匹配 MID ${mid}...`);
    metadata = scanOutputFolderForPost(mid);
  }

  if (!metadata) {
    return { success: false, message: `在本地文件或数据库中未找到 MID 为 ${mid} 的微博。` };
  }

  const { userName, postTime } = metadata;
  const monthSubDir = postTime.substring(0, 7); // "YYYY-MM"
  const datePart = postTime.substring(0, 10); // "YYYY-MM-DD"
  const userDir = path.join(config.OUTPUT_DIR, userName.replace(/[\\/:*?"<>|]/g, '_').trim());
  const monthDir = path.join(userDir, monthSubDir);

  // 3. Delete DB records
  if (config.DB_TYPE) {
    try {
      const db = getDb();
      const deletedComments = await db('comments').where({ post_id: mid }).delete();
      const deletedPosts = await db('posts').where({ id: mid }).delete();
      logger.info(`成功从数据库删除：${deletedPosts} 条微博，${deletedComments} 条评论。`);
    } catch (dbErr: any) {
      logger.error(`数据库删除 MID ${mid} 记录出错: ${dbErr.message}`);
    }
  }

  // 4. Collect all media files to delete across metadata, CSVs, and Markdown
  const mediaFilesToDelete = new Set<string>();

  metadata.localImages.forEach(f => mediaFilesToDelete.add(f));
  metadata.localVideos.forEach(f => mediaFilesToDelete.add(f));
  metadata.localLivephotos.forEach(f => mediaFilesToDelete.add(f));
  metadata.commentLocalImages.forEach(f => mediaFilesToDelete.add(f));

  if (metadata.cdnImages) metadata.cdnImages.forEach(f => mediaFilesToDelete.add(f));
  if (metadata.cdnVideos) metadata.cdnVideos.forEach(f => mediaFilesToDelete.add(f));
  if (metadata.cdnLivephotos) metadata.cdnLivephotos.forEach(f => mediaFilesToDelete.add(f));
  if (metadata.commentCdnImages) metadata.commentCdnImages.forEach(f => mediaFilesToDelete.add(f));

  // Also check monthDir/comments.csv for comments of this post
  const commentsCsvPath = path.join(monthDir, 'comments.csv');
  if (fs.existsSync(commentsCsvPath)) {
    try {
      const lines = fs.readFileSync(commentsCsvPath, 'utf8').split('\n');
      for (let i = 1; i < lines.length; i++) {
        const line = lines[i].trim();
        if (!line) continue;
        const cols = parseCsvLine(line);
        if (cols[1] === mid) {
          if (cols[9]) mediaFilesToDelete.add(cols[9]); // cdn_image
          if (cols[10]) mediaFilesToDelete.add(cols[10]); // local_image
        }
      }
    } catch {}
  }

  // Also check monthDir/posts.csv for media of this post
  const postsCsvPath = path.join(monthDir, 'posts.csv');
  if (fs.existsSync(postsCsvPath)) {
    try {
      const lines = fs.readFileSync(postsCsvPath, 'utf8').split('\n');
      for (let i = 1; i < lines.length; i++) {
        const line = lines[i].trim();
        if (!line) continue;
        const cols = parseCsvLine(line);
        if (cols[0] === mid) {
          parseMediaList(cols[8]).forEach(f => mediaFilesToDelete.add(f));
          parseMediaList(cols[9]).forEach(f => mediaFilesToDelete.add(f));
          parseMediaList(cols[10]).forEach(f => mediaFilesToDelete.add(f));
          parseMediaList(cols[11]).forEach(f => mediaFilesToDelete.add(f));
          parseMediaList(cols[12]).forEach(f => mediaFilesToDelete.add(f));
          parseMediaList(cols[13]).forEach(f => mediaFilesToDelete.add(f));
          if (cols[14]) parseMediaList(cols[14]).forEach(f => mediaFilesToDelete.add(f));
          if (cols[15]) parseMediaList(cols[15]).forEach(f => mediaFilesToDelete.add(f));
        }
      }
    } catch {}
  }

  // Also check Markdown file for image, video, and audio references inside this post's block
  const mdPath = path.join(monthDir, `${datePart}.md`);
  if (fs.existsSync(mdPath)) {
    try {
      const content = fs.readFileSync(mdPath, 'utf8');
      const tag = `<!-- post-id: ${mid} -->`;
      const startIndex = content.indexOf(tag);
      if (startIndex !== -1) {
        let endIndex = content.indexOf('<!-- post-id: ', startIndex + tag.length);
        if (endIndex === -1) endIndex = content.length;
        const block = content.substring(startIndex, endIndex);

        const mdImgRegex = /!\[.*?\]\(([^)]+)\)/g;
        let match;
        while ((match = mdImgRegex.exec(block)) !== null) {
          mediaFilesToDelete.add(match[1]);
        }
        const htmlSrcRegex = /<(?:img|video|audio)[^>]*src="([^"]+)"/gi;
        while ((match = htmlSrcRegex.exec(block)) !== null) {
          mediaFilesToDelete.add(match[1]);
        }
      }
    } catch {}
  }

  let filesDeletedCount = 0;
  for (const ref of mediaFilesToDelete) {
    if (deleteMediaCandidates(userDir, monthDir, ref)) {
      filesDeletedCount++;
    }
  }
  logger.info(`成功删除与微博 ${mid} 关联的 ${filesDeletedCount} 个媒体文件。`);

  // 5. Remove entry from JSON file
  const jsonPath = metadata.jsonPath || path.join(monthDir, 'json', `${datePart}.json`);
  if (fs.existsSync(jsonPath)) {
    try {
      const content = fs.readFileSync(jsonPath, 'utf8');
      const postsArray = JSON.parse(content);
      if (Array.isArray(postsArray)) {
        const filtered = postsArray.filter(p => p?.post?.id !== mid);
        if (filtered.length === 0) {
          fs.unlinkSync(jsonPath);
          logger.info(`JSON 归档文件已清空。已删除文件: ${jsonPath}`);
        } else {
          fs.writeFileSync(jsonPath, JSON.stringify(filtered, null, 2), 'utf8');
          logger.info(`已从 JSON 归档中移除该微博记录: ${jsonPath}`);
        }
      }
    } catch (jsonErr: any) {
      logger.error(`更新 JSON 文件 ${jsonPath} 失败: ${jsonErr.message}`);
    }
  }

  // 6. Remove post block from Markdown file
  if (fs.existsSync(mdPath)) {
    try {
      let content = fs.readFileSync(mdPath, 'utf8');
      const tag = `<!-- post-id: ${mid} -->`;
      const startIndex = content.indexOf(tag);
      if (startIndex !== -1) {
        let endIndex = content.indexOf('<!-- post-id: ', startIndex + tag.length);
        if (endIndex === -1) {
          endIndex = content.length;
        }

        const before = content.substring(0, startIndex);
        const after = content.substring(endIndex);
        let newContent = (before + after).trim();

        // Remove horizontal rule duplications and trailing horizontal rules
        newContent = newContent.replace(/\n\s*---\s*\n\s*---\s*\n/g, '\n---\n\n');
        
        // If no post tags left, delete file
        if (!newContent.includes('<!-- post-id: ')) {
          fs.unlinkSync(mdPath);
          logger.info(`Markdown 日志已清空。已删除文件: ${mdPath}`);
        } else {
          fs.writeFileSync(mdPath, newContent + '\n', 'utf8');
          logger.info(`已从 Markdown 日志中移除该微博区块: ${mdPath}`);
        }
      }
    } catch (mdErr: any) {
      logger.error(`更新 Markdown 文件 ${mdPath} 失败: ${mdErr.message}`);
    }
  }

  // 7. Clean CSV files (posts.csv & comments.csv)
  if (fs.existsSync(postsCsvPath)) {
    try {
      const lines = fs.readFileSync(postsCsvPath, 'utf8').split('\n');
      const header = lines[0];
      const dataLines = lines.slice(1);
      const remainingLines: string[] = [];

      for (const line of dataLines) {
        if (!line.trim()) continue;
        const columns = parseCsvLine(line);
        if (columns[0] !== mid) {
          remainingLines.push(line);
        }
      }

      if (remainingLines.length === 0) {
        fs.unlinkSync(postsCsvPath);
        logger.info(`CSV 文件已清空。已删除文件: ${postsCsvPath}`);
      } else {
        fs.writeFileSync(postsCsvPath, [header, ...remainingLines].join('\n') + '\n', 'utf8');
        logger.info(`已更新 posts.csv 文件: ${postsCsvPath}`);
      }
    } catch (csvErr: any) {
      logger.error(`更新 posts.csv 失败: ${csvErr.message}`);
    }
  }

  if (fs.existsSync(commentsCsvPath)) {
    try {
      const lines = fs.readFileSync(commentsCsvPath, 'utf8').split('\n');
      const header = lines[0];
      const dataLines = lines.slice(1);
      const remainingLines: string[] = [];

      for (const line of dataLines) {
        if (!line.trim()) continue;
        const columns = parseCsvLine(line);
        // Second column of comments.csv is post_id
        if (columns[1] !== mid) {
          remainingLines.push(line);
        }
      }

      if (remainingLines.length === 0) {
        fs.unlinkSync(commentsCsvPath);
        logger.info(`CSV 文件已清空。已删除文件: ${commentsCsvPath}`);
      } else {
        fs.writeFileSync(commentsCsvPath, [header, ...remainingLines].join('\n') + '\n', 'utf8');
        logger.info(`已更新 comments.csv 文件: ${commentsCsvPath}`);
      }
    } catch (csvErr: any) {
      logger.error(`更新 comments.csv 失败: ${csvErr.message}`);
    }
  }

  // 8. Clean up empty directories
  cleanEmptyDirs(userDir, monthDir);

  return { success: true, message: `成功删除微博 ${mid} 及其关联的数据库记录、CSV 行、Markdown 区块和媒体文件。` };
}

/**
 * Helper to traverse folder and check if a JSON has a post matching target UID
 */
function findFirstJsonFileForUser(bloggerPath: string, uid: string): boolean {
  try {
    const months = fs.readdirSync(bloggerPath);
    for (const month of months) {
      const monthPath = path.join(bloggerPath, month);
      if (!fs.statSync(monthPath).isDirectory()) continue;
      const jsonDir = path.join(monthPath, 'json');
      if (!fs.existsSync(jsonDir)) continue;
      const files = fs.readdirSync(jsonDir).filter(f => f.endsWith('.json'));
      for (const file of files) {
        const filePath = path.join(jsonDir, file);
        const content = fs.readFileSync(filePath, 'utf8');
        const parsed = JSON.parse(content);
        if (Array.isArray(parsed) && parsed.some(p => p?.post?.user_id === uid)) {
          return true;
        }
      }
    }
  } catch {}
  return false;
}

/**
 * Delete all post data for a specific date and blogger UID in an efficient batch operation
 */
export async function deleteDateData(uid: string, dateStr: string): Promise<{ success: boolean; message: string }> {
  // Resolve displayName (Nickname (UID) or just UID) for clearer logging
  let displayName = uid;
  try {
    const { readUsers } = require('../utils/userFileHelper');
    const users = readUsers();
    const match = users.find((u: any) => u.uid === uid);
    if (match?.name) {
      displayName = `${match.name} (${uid})`;
    }
  } catch {}

  logger.info(`正在初始化针对 ${displayName} 在日期: ${dateStr} 的定向高效批量删除...`);

  // 1. Resolve screenName/folderName
  let screenName = "";
  if (config.DB_TYPE) {
    try {
      const db = getDb();
      const row = await db('posts').where({ user_id: uid }).first();
      if (row?.user_name) {
        screenName = row.user_name;
      }
    } catch {}
  }

  if (!screenName) {
    try {
      const { readUsers } = require('../utils/userFileHelper');
      const users = readUsers();
      const match = users.find((u: any) => u.uid === uid);
      if (match?.name) {
        screenName = match.name;
      }
    } catch {}
  }

  const monthSubDir = dateStr.substring(0, 7); // "YYYY-MM"

  if (!screenName && fs.existsSync(config.OUTPUT_DIR)) {
    const folders = fs.readdirSync(config.OUTPUT_DIR);
    // Direct check for targeted date's JSON file first
    for (const folder of folders) {
      const targetJsonPath = path.join(config.OUTPUT_DIR, folder, monthSubDir, 'json', `${dateStr}.json`);
      if (fs.existsSync(targetJsonPath)) {
        try {
          const content = fs.readFileSync(targetJsonPath, 'utf8');
          const parsed = JSON.parse(content);
          if (Array.isArray(parsed) && parsed.some(p => p?.post?.user_id === uid)) {
            screenName = folder;
            break;
          }
        } catch {}
      }
    }

    // Direct check for targeted date's Markdown file
    if (!screenName) {
      for (const folder of folders) {
        const targetMdPath = path.join(config.OUTPUT_DIR, folder, monthSubDir, `${dateStr}.md`);
        if (fs.existsSync(targetMdPath)) {
          screenName = folder;
          break;
        }
      }
    }

    if (!screenName) {
      for (const folder of folders) {
        const folderPath = path.join(config.OUTPUT_DIR, folder);
        if (!fs.statSync(folderPath).isDirectory()) continue;
        if (findFirstJsonFileForUser(folderPath, uid)) {
          screenName = folder;
          break;
        }
      }
    }

    if (!screenName) {
      for (const folder of folders) {
        if (folder.includes(uid)) {
          screenName = folder;
          break;
        }
      }
    }
  }

  const postIds = new Set<string>();
  const mediaFilesToDelete = new Set<string>();

  const sanitizedUserDir = screenName ? path.join(config.OUTPUT_DIR, screenName.replace(/[\\/:*?"<>|]/g, '_').trim()) : null;
  const monthDir = sanitizedUserDir ? path.join(sanitizedUserDir, monthSubDir) : null;
  const jsonPath = monthDir ? path.join(monthDir, 'json', `${dateStr}.json`) : null;
  const mdPath = monthDir ? path.join(monthDir, `${dateStr}.md`) : null;
  const postsCsvPath = monthDir ? path.join(monthDir, 'posts.csv') : null;
  const commentsCsvPath = monthDir ? path.join(monthDir, 'comments.csv') : null;

  // 2. Locate post IDs and media files from JSON archive (One single read!)
  if (jsonPath && fs.existsSync(jsonPath)) {
    try {
      const content = fs.readFileSync(jsonPath, 'utf8');
      const parsed = JSON.parse(content);
      if (Array.isArray(parsed)) {
        for (const item of parsed) {
          if (item?.post?.id) {
            postIds.add(item.post.id);
            parseMediaList(item.post.local_images).forEach(f => mediaFilesToDelete.add(f));
            parseMediaList(item.post.local_videos).forEach(f => mediaFilesToDelete.add(f));
            parseMediaList(item.post.local_livephotos).forEach(f => mediaFilesToDelete.add(f));
            parseMediaList(item.post.cdn_images || item.post.original_pictures).forEach(f => mediaFilesToDelete.add(f));
            parseMediaList(item.post.cdn_videos || item.post.video_url).forEach(f => mediaFilesToDelete.add(f));
            parseMediaList(item.post.cdn_livephotos || item.post.livephotos).forEach(f => mediaFilesToDelete.add(f));
            const comments = item.comments || [];
            comments.forEach((c: any) => {
              if (c?.local_image) mediaFilesToDelete.add(c.local_image);
              if (c?.cdn_image || c?.image_url) mediaFilesToDelete.add(c.cdn_image || c.image_url);
            });
          }
        }
      }
    } catch (err: any) {
      logger.warn(`按日期删除期间读取每日 JSON 文件 ${jsonPath} 失败: ${err.message}`);
    }
  }

  // 3. Fallback / Complement: Locate post IDs and media files from Markdown file (Before deleting mdPath!)
  if (mdPath && fs.existsSync(mdPath)) {
    try {
      const mdContent = fs.readFileSync(mdPath, 'utf8');
      const midRegex = /<!--\s*post-id:\s*(\d+)\s*-->/g;
      let match;
      while ((match = midRegex.exec(mdContent)) !== null) {
        postIds.add(match[1]);
      }
      const mdImgRegex = /!\[.*?\]\(([^)]+)\)/g;
      while ((match = mdImgRegex.exec(mdContent)) !== null) {
        mediaFilesToDelete.add(match[1]);
      }
      const htmlSrcRegex = /<(?:img|video)[^>]*src="([^"]+)"/gi;
      while ((match = htmlSrcRegex.exec(mdContent)) !== null) {
        mediaFilesToDelete.add(match[1]);
      }
    } catch (err: any) {
      logger.warn(`按日期删除期间读取每日 Markdown 文件 ${mdPath} 失败: ${err.message}`);
    }
  }

  // 4. Complement: Locate post IDs and media files from CSV files
  if (postsCsvPath && fs.existsSync(postsCsvPath)) {
    try {
      const lines = fs.readFileSync(postsCsvPath, 'utf8').split('\n');
      for (let i = 1; i < lines.length; i++) {
        const line = lines[i].trim();
        if (!line) continue;
        const cols = parseCsvLine(line);
        if (cols[1]?.startsWith(dateStr) || postIds.has(cols[0])) {
          postIds.add(cols[0]);
          parseMediaList(cols[8]).forEach(f => mediaFilesToDelete.add(f)); // cdn_images
          parseMediaList(cols[9]).forEach(f => mediaFilesToDelete.add(f)); // local_images
          parseMediaList(cols[10]).forEach(f => mediaFilesToDelete.add(f)); // cdn_videos
          parseMediaList(cols[11]).forEach(f => mediaFilesToDelete.add(f)); // local_videos
          parseMediaList(cols[12]).forEach(f => mediaFilesToDelete.add(f)); // cdn_livephotos
          parseMediaList(cols[13]).forEach(f => mediaFilesToDelete.add(f)); // local_livephotos
        }
      }
    } catch (err: any) {
      logger.warn(`按日期删除期间读取 posts.csv 失败: ${err.message}`);
    }
  }

  if (commentsCsvPath && fs.existsSync(commentsCsvPath)) {
    try {
      const lines = fs.readFileSync(commentsCsvPath, 'utf8').split('\n');
      for (let i = 1; i < lines.length; i++) {
        const line = lines[i].trim();
        if (!line) continue;
        const cols = parseCsvLine(line);
        if (postIds.has(cols[1]) || cols[3]?.startsWith(dateStr)) {
          if (cols[9]) mediaFilesToDelete.add(cols[9]); // cdn_image
          if (cols[10]) mediaFilesToDelete.add(cols[10]); // local_image
        }
      }
    } catch (err: any) {
      logger.warn(`按日期删除期间读取 comments.csv 失败: ${err.message}`);
    }
  }

  // 5. Complement: Query DB for this date (One single query!)
  if (config.DB_TYPE) {
    try {
      const db = getDb();
      const rows = await db('posts')
        .where({ user_id: uid })
        .andWhere('time', 'like', `${dateStr}%`)
        .select('id', 'local_images', 'local_videos', 'local_livephotos', 'cdn_images', 'cdn_videos', 'cdn_livephotos');
      for (const row of rows) {
        postIds.add(row.id);
        parseMediaList(row.local_images).forEach(f => mediaFilesToDelete.add(f));
        parseMediaList(row.local_videos).forEach(f => mediaFilesToDelete.add(f));
        parseMediaList(row.local_livephotos).forEach(f => mediaFilesToDelete.add(f));
        parseMediaList(row.cdn_images).forEach(f => mediaFilesToDelete.add(f));
        parseMediaList(row.cdn_videos).forEach(f => mediaFilesToDelete.add(f));
        parseMediaList(row.cdn_livephotos).forEach(f => mediaFilesToDelete.add(f));
      }
      if (postIds.size > 0) {
        const commentRows = await db('comments').whereIn('post_id', Array.from(postIds)).select('local_image', 'cdn_image');
        for (const c of commentRows) {
          if (c.local_image) mediaFilesToDelete.add(c.local_image);
          if (c.cdn_image) mediaFilesToDelete.add(c.cdn_image);
        }
      }
    } catch (err: any) {
      logger.error(`按日期删除期间从数据库查询微博记录失败: ${err.message}`);
    }
  }

  if (postIds.size === 0 && mediaFilesToDelete.size === 0) {
    return { success: false, message: `在数据库或本地备份中未找到 ${displayName} 在日期 ${dateStr} 的微博。` };
  }

  logger.info(`找到 ${displayName} 在日期 ${dateStr} 的共计 ${postIds.size} 条微博，关联待清理媒体项 ${mediaFilesToDelete.size} 个。开始执行批量删除...`);

  // 6. Batch delete media files on disk
  let mediaDeletedCount = 0;
  for (const ref of mediaFilesToDelete) {
    if (deleteMediaCandidates(sanitizedUserDir || '', monthDir || '', ref)) {
      mediaDeletedCount++;
    }
  }
  logger.info(`成功物理清理与日期 ${dateStr} 关联的 ${mediaDeletedCount} 个媒体文件。`);

  // 7. Batch delete daily JSON and Markdown files directly (1 single unlink each!)
  if (jsonPath && fs.existsSync(jsonPath)) {
    try {
      fs.unlinkSync(jsonPath);
      logger.info(`已删除每日 JSON 归档: ${jsonPath}`);
    } catch (err: any) {
      logger.error(`删除每日 JSON 文件 ${jsonPath} 失败: ${err.message}`);
    }
  }

  if (mdPath && fs.existsSync(mdPath)) {
    try {
      fs.unlinkSync(mdPath);
      logger.info(`已删除每日 Markdown 归档: ${mdPath}`);
    } catch (err: any) {
      logger.error(`删除每日 Markdown 文件 ${mdPath} 失败: ${err.message}`);
    }
  }

  // 8. Batch update CSV files (One single read & write each!)
  if (postsCsvPath && fs.existsSync(postsCsvPath)) {
    try {
      const lines = fs.readFileSync(postsCsvPath, 'utf8').split('\n');
      const header = lines[0];
      const dataLines = lines.slice(1);
      const remainingLines: string[] = [];

      for (const line of dataLines) {
        if (!line.trim()) continue;
        const columns = parseCsvLine(line);
        // columns[0] is mid, columns[1] is time
        if (!postIds.has(columns[0]) && !columns[1]?.startsWith(dateStr)) {
          remainingLines.push(line);
        }
      }

      if (remainingLines.length === 0) {
        fs.unlinkSync(postsCsvPath);
        logger.info(`CSV 文件已清空。已删除文件: ${postsCsvPath}`);
      } else {
        fs.writeFileSync(postsCsvPath, [header, ...remainingLines].join('\n') + '\n', 'utf8');
        logger.info(`已批量更新 posts.csv 文件: ${postsCsvPath}`);
      }
    } catch (csvErr: any) {
      logger.error(`更新 posts.csv 失败: ${csvErr.message}`);
    }
  }

  if (commentsCsvPath && fs.existsSync(commentsCsvPath)) {
    try {
      const lines = fs.readFileSync(commentsCsvPath, 'utf8').split('\n');
      const header = lines[0];
      const dataLines = lines.slice(1);
      const remainingLines: string[] = [];

      for (const line of dataLines) {
        if (!line.trim()) continue;
        const columns = parseCsvLine(line);
        // Column 1 is post_id, column 3 is time
        if (!postIds.has(columns[1]) && !columns[3]?.startsWith(dateStr)) {
          remainingLines.push(line);
        }
      }

      if (remainingLines.length === 0) {
        fs.unlinkSync(commentsCsvPath);
        logger.info(`CSV 文件已清空。已删除文件: ${commentsCsvPath}`);
      } else {
        fs.writeFileSync(commentsCsvPath, [header, ...remainingLines].join('\n') + '\n', 'utf8');
        logger.info(`已批量更新 comments.csv 文件: ${commentsCsvPath}`);
      }
    } catch (csvErr: any) {
      logger.error(`更新 comments.csv 失败: ${csvErr.message}`);
    }
  }

  // 9. Batch delete DB records (One single query for comments and posts!)
  if (config.DB_TYPE) {
    try {
      const db = getDb();
      const idArray = Array.from(postIds);
      let deletedComments = 0;
      let deletedPosts = 0;
      if (idArray.length > 0) {
        deletedComments = await db('comments').whereIn('post_id', idArray).delete();
        deletedPosts = await db('posts').whereIn('id', idArray).delete();
      } else {
        deletedPosts = await db('posts').where({ user_id: uid }).andWhere('time', 'like', `${dateStr}%`).delete();
      }
      logger.info(`成功从数据库批量删除：${deletedPosts} 条微博，${deletedComments} 条评论。`);
    } catch (dbErr: any) {
      logger.error(`数据库批量删除日期 ${dateStr} 记录出错: ${dbErr.message}`);
    }
  }

  // 10. Clean up empty directories
  cleanEmptyDirs(sanitizedUserDir, monthDir);

  return {
    success: true,
    message: `成功批量删除 ${displayName} 在日期 ${dateStr} 的共计 ${postIds.size} 条微博及其关联数据与媒体文件。`
  };
}
