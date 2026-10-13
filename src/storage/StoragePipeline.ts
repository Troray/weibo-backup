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
   * Helper to resolve output directory paths for a post.
   */
  private getStorageDirs(post: ParsedPost, screenName: string) {
    const sanitizedScreenName = screenName.replace(/[\\/:*?"<>|]/g, '_').trim();
    const userDir = path.join(config.OUTPUT_DIR, sanitizedScreenName);
    const monthSubDir = post.time.substring(0, 7); // "YYYY-MM"
    const monthDir = path.join(userDir, monthSubDir);

    if (!fs.existsSync(monthDir)) {
      fs.mkdirSync(monthDir, { recursive: true });
    }
    return { sanitizedScreenName, userDir, monthSubDir, monthDir };
  }

  /**
   * Helper to upsert a daily JSON entry for a post and its comments.
   */
  private saveDailyJson(post: any, comments: any[], monthDir: string): void {
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
      post,
      comments
    };

    const existingIndex = dailyPosts.findIndex(item => item?.post?.id === post.id);
    if (existingIndex > -1) {
      dailyPosts[existingIndex] = newEntry;
    } else {
      dailyPosts.push(newEntry);
    }

    fs.writeFileSync(jsonPath, JSON.stringify(dailyPosts, null, 2), 'utf8');
  }

  /**
   * 先行安全归档博文正文及多媒体（正文优先模式）。
   * 在耗时较长的海量评论抓取之前，先把正文、超清视频、图片等落盘，确保突发中断不丢正文与多媒体。
   */
  async processPost(
    post: ParsedPost,
    screenName: string,
    uid: string
  ): Promise<void> {
    const { userDir, monthSubDir, monthDir } = this.getStorageDirs(post, screenName);

    const enrichedPost = {
      ...post,
      user_id: uid,
      user_name: screenName
    };

    // 1. 下载博文多媒体
    logger.info(`开始为微博 ${post.id} 下载媒体资源... (图片: ${post.cdn_images.length} 张, 视频: ${post.cdn_videos.length} 个, 实况: ${post.cdn_livephotos.length} 个, 语音: ${post.cdn_audios?.length || 0} 个, 类型: ${post.is_retweet ? '转发' : '原创'})`);
    try {
      const localMedia = await this.downloader.downloadPostMedia(
        post.id,
        post.time,
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

      // 同步回原 post 对象引用，保证外部报告和统计准确
      post.local_images = localMedia.localImages;
      post.local_videos = localMedia.localVideos;
      post.local_livephotos = localMedia.localLivePhotos;
      post.local_audios = localMedia.localAudios;
    } catch (mediaErr) {
      logger.error(`为微博 ${post.id} 下载媒体资源出错:`, mediaErr);
    }

    // 2. 写入数据库 posts 表
    if (config.DB_TYPE) {
      try {
        const db = getDb();
        await upsertPost(db, enrichedPost);
        logger.info(`微博 ${post.id} 正文数据已预先保存到数据库。`);
      } catch (dbErr) {
        logger.error(`预先保存微博 ${post.id} 到数据库失败:`, dbErr);
      }
    }

    // 3. 写入 CSV
    if (config.SAVE_TYPES.includes('csv')) {
      try {
        await appendPostToCsv(enrichedPost, userDir, monthSubDir);
        logger.info(`微博 ${post.id} 正文已预先写入 CSV。`);
      } catch (csvErr) {
        logger.error(`预先写入微博 ${post.id} 到 CSV 失败:`, csvErr);
      }
    }

    // 4. 写入 Markdown (此时评论暂为空数组)
    if (config.SAVE_TYPES.includes('markdown')) {
      try {
        await appendPostToMarkdown(enrichedPost, [], userDir, monthSubDir, uid);
      } catch (mdErr) {
        logger.error(`预先写入微博 ${post.id} 到 Markdown 失败:`, mdErr);
      }
    }

    // 5. 写入 JSON (此时评论暂为空数组)
    if (config.SAVE_TYPES.includes('json')) {
      try {
        this.saveDailyJson(enrichedPost, [], monthDir);
        logger.info(`微博 ${post.id} 的原始 JSON 数据已预先保存到每日文件。`);
      } catch (jsonErr) {
        logger.error(`预先写入微博 ${post.id} 到 JSON 发生错误:`, jsonErr);
      }
    }

    logger.info(`✅ 微博 ${post.id} 正文及媒体已优先安全归档！接下来开始抓取评论...`);
  }

  /**
   * 流式分批追加已抓取的评论到数据库和 CSV（增量高效刷盘）
   */
  async appendCommentsBatch(
    post: ParsedPost,
    commentsBatch: ParsedComment[],
    screenName: string,
    uid: string
  ): Promise<void> {
    if (!commentsBatch || commentsBatch.length === 0) return;
    const { userDir, monthSubDir } = this.getStorageDirs(post, screenName);

    // 1. 批量追加/更新到数据库
    if (config.DB_TYPE) {
      try {
        const db = getDb();
        for (const comment of commentsBatch) {
          await upsertComment(db, comment);
        }
      } catch (dbErr) {
        logger.error(`流式保存微博 ${post.id} 评论批次 (${commentsBatch.length} 条) 到数据库失败:`, dbErr);
      }
    }

    // 2. 批量追加到 CSV (内置去重)
    if (config.SAVE_TYPES.includes('csv')) {
      try {
        await appendCommentsToCsv(commentsBatch, userDir, monthSubDir);
      } catch (csvErr) {
        logger.error(`流式追加微博 ${post.id} 评论批次 (${commentsBatch.length} 条) 到 CSV 失败:`, csvErr);
      }
    }
  }

  /**
   * 评论抓取完成（或中断收尾）时最终全量更新同步 Markdown / JSON / DB / CSV。
   */
  async finishPostComments(
    post: ParsedPost,
    allComments: ParsedComment[],
    screenName: string,
    uid: string
  ): Promise<void> {
    const { userDir, monthSubDir, monthDir } = this.getStorageDirs(post, screenName);
    const enrichedPost = {
      ...post,
      user_id: uid,
      user_name: screenName
    };

    let enrichedComments = [...allComments];
    // 下载评论媒体（若开启）
    if (config.DOWNLOAD_COMMENT_MEDIA && allComments.length > 0) {
      logger.info(`开始为微博 ${post.id} 的评论下载媒体资源...`);
      try {
        const commentMediaMap = await this.downloader.downloadCommentMedia(
          allComments,
          userDir,
          monthSubDir
        );
        enrichedComments = allComments.map(c => {
          const localPath = commentMediaMap.get(c.id) || null;
          c.local_image = localPath;
          return {
            ...c,
            local_image: localPath
          };
        });
      } catch (commentMediaErr) {
        logger.error(`为微博 ${post.id} 下载评论媒体资源出错:`, commentMediaErr);
      }
    }

    // 1. 确保数据库完整
    if (config.DB_TYPE) {
      try {
        const db = getDb();
        await upsertPost(db, enrichedPost);
        for (const comment of enrichedComments) {
          await upsertComment(db, comment);
        }
        logger.info(`微博 ${post.id}（含 ${enrichedComments.length} 条评论）已全量同步到数据库。`);
      } catch (dbErr) {
        logger.error(`最终同步微博 ${post.id} 及评论到数据库失败:`, dbErr);
      }
    }

    // 2. 确保 CSV 补齐（appendCommentsToCsv 自带去重，幂等安全）
    if (config.SAVE_TYPES.includes('csv')) {
      try {
        await appendPostToCsv(enrichedPost, userDir, monthSubDir);
        if (enrichedComments.length > 0) {
          await appendCommentsToCsv(enrichedComments, userDir, monthSubDir);
          logger.info(`微博 ${post.id} 全部评论已同步写入 CSV。`);
        }
      } catch (csvErr) {
        logger.error(`最终同步微博 ${post.id} 到 CSV 失败:`, csvErr);
      }
    }

    // 3. 原地覆盖更新 Markdown（替换 postBlock，加入完整评论列表）
    if (config.SAVE_TYPES.includes('markdown')) {
      try {
        await appendPostToMarkdown(enrichedPost, enrichedComments, userDir, monthSubDir, uid);
      } catch (mdErr) {
        logger.error(`最终覆盖更新微博 ${post.id} 到 Markdown 失败:`, mdErr);
      }
    }

    // 4. 原地覆盖更新每日 JSON
    if (config.SAVE_TYPES.includes('json')) {
      try {
        this.saveDailyJson(enrichedPost, enrichedComments, monthDir);
        logger.info(`微博 ${post.id}（含 ${enrichedComments.length} 条评论）已全量更新到每日 JSON。`);
      } catch (jsonErr) {
        logger.error(`最终写入微博 ${post.id} 到 JSON 发生错误:`, jsonErr);
      }
    }
  }

  /**
   * 原生经典模式：一次性处理整篇博文与评论（适合评论量较少的小博文，或作为统一入口）。
   */
  async process(
    post: ParsedPost,
    comments: ParsedComment[],
    screenName: string,
    uid: string
  ): Promise<void> {
    const { userDir, monthSubDir, monthDir } = this.getStorageDirs(post, screenName);

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
        post.time,
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

      // 修复：必须同时同步回传入的原 post 引用，确保外部 Scraper 统计和报告准确
      post.local_images = localMedia.localImages;
      post.local_videos = localMedia.localVideos;
      post.local_livephotos = localMedia.localLivePhotos;
      post.local_audios = localMedia.localAudios;
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
          c.local_image = localPath;
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

    // 6. Save raw JSON file
    if (config.SAVE_TYPES.includes('json')) {
      try {
        this.saveDailyJson(enrichedPost, enrichedComments, monthDir);
        logger.info(`微博 ${post.id} 的原始 JSON 数据已成功保存到每日文件`);
      } catch (jsonErr) {
        logger.error(`写入微博 ${post.id} 到 JSON 发生错误:`, jsonErr);
      }
    }
  }
}
