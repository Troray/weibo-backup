import * as fs from 'fs';
import * as path from 'path';
import { ParsedPost, ParsedComment } from '../scraper/parser';
import { logger } from '../utils/logger';

/**
 * Media helper to strip YYYY-MM/ prefix to make paths relative to the daily MD file
 */
function getRelativePath(p: string): string {
  if (!p) return '';
  const normalized = p.replace(/\\/g, '/');
  const idx = normalized.indexOf('/');
  return idx !== -1 ? normalized.substring(idx + 1) : normalized;
}

/**
 * Appends a parsed post (with its comments) to a daily Markdown file.
 * Path format: output/博主昵称/YYYY-MM/YYYY-MM-DD.md
 */
export async function appendPostToMarkdown(
  post: ParsedPost,
  comments: ParsedComment[],
  userDir: string,
  monthSubDir: string,
  userId: string
): Promise<void> {
  const dir = path.join(userDir, monthSubDir);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  // Extract date in YYYY-MM-DD format from post.time (ISO string)
  const datePart = post.time.substring(0, 10); // "YYYY-MM-DD"
  const mdPath = path.join(dir, `${datePart}.md`);
  const fileExists = fs.existsSync(mdPath);

  let existingContent = '';
  if (fileExists) {
    try {
      existingContent = fs.readFileSync(mdPath, 'utf8');
    } catch (err) {
      logger.error(`读取 Markdown 文件 ${mdPath} 失败:`, err);
    }
  }

  const marker = `<!-- post-id: ${post.id} -->`;

  // Build markdown text for the post
  let postBlock = `${marker}\n`;
  postBlock += `## 📝 微博 [${post.id}](https://weibo.com/${userId}/${post.id})\n\n`;
  postBlock += `📅 **发布时间**: ${post.time} | 📱 **发布设备**: ${post.device || '未知'} | 📍 **发布位置**: ${post.ip_location || '未知'}\n`;
  postBlock += `🔁 **转发**: ${post.reposts_count} | 💬 **评论**: ${post.comments_count} | 👍 **点赞**: ${post.attitudes_count}\n\n`;

  // Audio and transcript section (如果有语音音频排在正文最前面)
  if (post.local_audios && post.local_audios.length > 0) {
    postBlock += `### 🎙️ 语音 (Audio)\n\n`;
    const audioList = post.local_audios.map(aud => `<audio src="${getRelativePath(aud)}" controls></audio>`);
    postBlock += audioList.join('\n\n') + '\n\n';
    if (post.audio_transcript) {
      postBlock += `> 📝 **语音转写**: ${post.audio_transcript}\n\n`;
    }
  }

  postBlock += `### 💬 正文\n\n${post.content}\n\n`;

  // Retweet source status block
  if (post.is_retweet) {
    postBlock += `> 🔁 **转发自**: @${post.retweeted_user || '未知'}\n`;
    postBlock += `> **原博内容**: ${post.retweeted_content || '未知'}\n\n`;
  }

  if (post.local_images && post.local_images.length > 0) {
    postBlock += `### 📷 图片\n\n`;
    const imageList = post.local_images.map(img => `![图片](${getRelativePath(img)})`);
    postBlock += imageList.join('\n\n') + '\n\n';
  }

  if (post.local_videos && post.local_videos.length > 0) {
    postBlock += `### 🎥 视频\n\n`;
    const videoList = post.local_videos.map(vid => `<video src="${getRelativePath(vid)}" controls width="100%" style="max-width:600px;"></video>`);
    postBlock += videoList.join('\n\n') + '\n\n';
  }

  if (post.local_livephotos && post.local_livephotos.length > 0) {
    postBlock += `### 🎞️ 实况照片 (Live Photo)\n\n`;
    const livePhotoList = post.local_livephotos.map(lp => `<video src="${getRelativePath(lp)}" controls loop muted width="100%" style="max-width:400px;"></video>`);
    postBlock += livePhotoList.join('\n\n') + '\n\n';
  }

  // Comments section
  if (comments && comments.length > 0) {
    postBlock += `### 💬 微博评论\n\n`;

    // Group parent and child comments using a Map for O(N) linear time nesting
    const mainComments: ParsedComment[] = [];
    const subCommentsByParent = new Map<string, ParsedComment[]>();

    for (const c of comments) {
      if (!c.parent_id) {
        mainComments.push(c);
      } else {
        let list = subCommentsByParent.get(c.parent_id);
        if (!list) {
          list = [];
          subCommentsByParent.set(c.parent_id, list);
        }
        list.push(c);
      }
    }

    for (const main of mainComments) {
      let mainImgHtml = '';
      if (main.local_image) {
        mainImgHtml = `\n  <img src="${getRelativePath(main.local_image)}" width="25%" />\n`;
      }
      const mainTime = main.time ? `*(${formatCommentTime(main.time)})*` : '';
      postBlock += `- 👤 **${main.user_name}** : ${main.content.replace(/\n/g, ' ')} (IP: ${main.ip_location || '未知'} | 赞 ${main.like_count})${mainTime}${mainImgHtml}\n`;

      const replies = subCommentsByParent.get(main.id) || [];
      for (const reply of replies) {
        let replyImgHtml = '';
        if (reply.local_image) {
          replyImgHtml = `\n    <img src="${getRelativePath(reply.local_image)}" width="25%" />\n`;
        }
        const replyTime = reply.time ? `*(${formatCommentTime(reply.time)})*` : '';
        postBlock += `  - 👤 **${reply.user_name}** : ${reply.content.replace(/\n/g, ' ')} (IP: ${reply.ip_location || '未知'} | 赞 ${reply.like_count})${replyTime}${replyImgHtml}\n`;
      }
    }
  }

  postBlock += `\n---\n\n`;

  // If the post already exists in this markdown file (e.g. supplementary crawl or re-crawl), update it in place!
  if (fileExists && existingContent.includes(marker)) {
    try {
      const startIndex = existingContent.indexOf(marker);
      const nextMarker = existingContent.indexOf('<!-- post-id:', startIndex + marker.length);
      const endIndex = nextMarker !== -1 ? nextMarker : existingContent.length;

      const updatedContent = existingContent.substring(0, startIndex) + postBlock + existingContent.substring(endIndex);
      fs.writeFileSync(mdPath, updatedContent, 'utf8');
      logger.info(`微博 ${post.id}（含 ${comments.length} 条评论）已成功更新覆盖到 Markdown 日报文件: ${mdPath}`);
      return;
    } catch (err) {
      logger.error(`更新覆盖微博 ${post.id} 到 Markdown 文件失败:`, err);
      return;
    }
  }

  // Otherwise, append the post block (adding header if file is new or empty)
  let mdContent = '';
  if (!fileExists || !existingContent.trim()) {
    mdContent += `# 📱 ${post.user_name || '用户'} - ${datePart} - 微博日报\n\n`;
    mdContent += `> 此文件备份了博主在 ${datePart} 发布的微博。\n\n`;
  }
  mdContent += postBlock;

  try {
    fs.appendFileSync(mdPath, mdContent, 'utf8');
    logger.info(`微博 ${post.id}（含 ${comments.length} 条评论）已成功追加到 Markdown 日报文件: ${mdPath}`);
  } catch (err) {
    logger.error(`写入微博 ${post.id} 到 Markdown 文件失败:`, err);
  }
}

/**
 * Format ISO datetime string to YYYY-MM-DD HH:mm:ss in local time
 */
function formatCommentTime(isoStr: string): string {
  if (!isoStr) return '';
  try {
    const d = new Date(isoStr);
    if (!isNaN(d.getTime())) {
      const pad = (num: number) => String(num).padStart(2, '0');
      const y = d.getFullYear();
      const m = pad(d.getMonth() + 1);
      const day = pad(d.getDate());
      const h = pad(d.getHours());
      const min = pad(d.getMinutes());
      const s = pad(d.getSeconds());
      return `${y}-${m}-${day} ${h}:${min}:${s}`;
    }
  } catch { }
  return isoStr.replace('T', ' ').substring(0, 19);
}
