import * as path from 'path';
import * as fs from 'fs';
import { config } from '../config';
import { logger } from '../utils/logger';
import { ParsedPost, ParsedComment } from '../scraper/parser';
import { MediaDownloader } from '../downloader/MediaDownloader';
import { getDb, initializeSchema, upsertPost, upsertComment } from './db';
import { appendPostToCsv, appendCommentsToCsv } from './csv';
import { appendPostToMarkdown } from './markdown';

export class StoragePipeline {
  private downloader: MediaDownloader;

  constructor() {
    this.downloader = new MediaDownloader();
  }

  /**
   * Initializes the pipeline, including database tables.
   */
  async initialize(): Promise<void> {
    if (!config.DB_TYPE) {
      logger.info('数据库持久化已禁用 (WEIBO_DB_TYPE 未配置)。');
      return;
    }
    try {
      const db = getDb();
      await initializeSchema(db);
    } catch (err) {
      logger.error('流水线初始化数据库表结构失败:', err);
      throw err;
    }
  }

  /**
   * Processes a single crawled post: downloads media, updates fields, and writes to all targets.
   */
  async process(
    post: ParsedPost,
    comments: ParsedComment[],
    screenName: string,
    uid: string
  ): Promise<void> {
    // 1. Sanitize folder name
    const sanitizedScreenName = screenName.replace(/[\\/:*?"<>|]/g, '_').trim();
    const userDir = path.join(config.OUTPUT_DIR, sanitizedScreenName);
    
    // YYYY-MM directory format from post date
    const monthSubDir = post.time.substring(0, 7); // "YYYY-MM"
    const monthDir = path.join(userDir, monthSubDir);

    if (!fs.existsSync(monthDir)) {
      fs.mkdirSync(monthDir, { recursive: true });
    }

    // Attach user screen name & uid fields to post data (used in DB)
    const enrichedPost = {
      ...post,
      user_id: uid,
      user_name: screenName
    };

    // 2. Download media assets concurrently
    logger.info(`开始为微博 ${post.id} 下载媒体资源... (图片: ${post.cdn_images.length} 张, 视频: ${post.cdn_videos.length} 个, 实况: ${post.cdn_livephotos.length} 个, 语音: ${post.cdn_audios?.length || 0} 个, 类型: ${post.is_retweet ? '转发' : '原创'})`);
    try {
      const localMedia = await this.downloader.downloadPostMedia(
        post.id,
        post.cdn_images,
        post.cdn_videos,
        post.cdn_livephotos,
        post.cdn_audios || [],
        userDir,
        monthSubDir,
        post.is_retweet
      );

      enrichedPost.local_images = localMedia.localImages;
      enrichedPost.local_videos = localMedia.localVideos;
      enrichedPost.local_livephotos = localMedia.localLivePhotos;
      enrichedPost.local_audios = localMedia.localAudios;
    } catch (mediaErr) {
      logger.error(`为微博 ${post.id} 下载媒体资源出错:`, mediaErr);
    }

    // 2.5 Download comment media concurrently
    let enrichedComments = [...comments];
    if (config.DOWNLOAD_COMMENT_MEDIA && comments.length > 0) {
      logger.info(`开始为微博 ${post.id} 的评论下载媒体资源...`);
      try {
        const commentMediaMap = await this.downloader.downloadCommentMedia(
          comments,
          userDir,
          monthSubDir
        );
        enrichedComments = comments.map(c => {
          const localPath = commentMediaMap.get(c.id) || null;
          return {
            ...c,
            local_image: localPath
          };
        });
      } catch (commentMediaErr) {
        logger.error(`为微博 ${post.id} 下载评论媒体资源出错:`, commentMediaErr);
      }
    }

    // 3. Save to database (SQLite / MySQL / Postgres)
    if (config.DB_TYPE) {
      try {
        const db = getDb();
        await upsertPost(db, enrichedPost);
        
        for (const comment of enrichedComments) {
          await upsertComment(db, comment);
        }
        logger.info(`微博 ${post.id}（含 ${enrichedComments.length} 条评论）已成功保存到数据库。`);
      } catch (dbErr) {
        logger.error(`保存微博 ${post.id} 到数据库失败:`, dbErr);
      }
    }

    // 4. Save to CSV
    if (config.SAVE_TYPES.includes('csv')) {
      try {
        await appendPostToCsv(enrichedPost, userDir, monthSubDir);
        if (enrichedComments.length > 0) {
          await appendCommentsToCsv(enrichedComments, userDir, monthSubDir);
          logger.info(`微博 ${post.id} 及评论已成功写入 CSV。`);
        } else {
          logger.info(`微博 ${post.id} 已成功写入 CSV。`);
        }
      } catch (csvErr) {
        logger.error(`写入微博 ${post.id} 到 CSV 失败:`, csvErr);
      }
    }

    // 5. Save to Markdown
    if (config.SAVE_TYPES.includes('markdown')) {
      try {
        await appendPostToMarkdown(enrichedPost, enrichedComments, userDir, monthSubDir, uid);
      } catch (mdErr) {
        logger.error(`写入微博 ${post.id} 到 Markdown 失败:`, mdErr);
      }
    }

    // 6. Save raw JSON file (group posts by day YYYY-MM-DD into a single JSON array)
    if (config.SAVE_TYPES.includes('json')) {
      try {
        const jsonDir = path.join(monthDir, 'json');
        if (!fs.existsSync(jsonDir)) {
          fs.mkdirSync(jsonDir, { recursive: true });
        }
        const dateStr = post.time.substring(0, 10); // "YYYY-MM-DD"
        const jsonPath = path.join(jsonDir, `${dateStr}.json`);
        
        let dailyPosts: any[] = [];
        if (fs.existsSync(jsonPath)) {
          try {
            const content = fs.readFileSync(jsonPath, 'utf8');
            const parsed = JSON.parse(content);
            if (Array.isArray(parsed)) {
              dailyPosts = parsed;
            }
          } catch (e) {
            logger.warn(`解析已存在的 JSON 文件 ${jsonPath} 失败，将覆盖写入:`, e);
          }
        }

        const newEntry = {
          post: enrichedPost,
          comments: enrichedComments
        };

        // Upsert to prevent duplicate posts in the same JSON array
        const existingIndex = dailyPosts.findIndex(item => item?.post?.id === enrichedPost.id);
        if (existingIndex > -1) {
          dailyPosts[existingIndex] = newEntry;
        } else {
          dailyPosts.push(newEntry);
        }

        fs.writeFileSync(jsonPath, JSON.stringify(dailyPosts, null, 2), 'utf8');
        logger.info(`微博 ${post.id} 的原始 JSON 数据已成功保存到每日文件 ${jsonPath}`);
      } catch (jsonErr) {
        logger.error(`写入微博 ${post.id} 到 JSON 发生错误:`, jsonErr);
      }
    }
  }
}
