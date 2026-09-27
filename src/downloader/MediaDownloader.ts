import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { Readable } from 'stream';
import { pipeline } from 'stream/promises';
import * as cliProgress from 'cli-progress';
import { config } from '../config';
import { logger } from '../utils/logger';
import { ParsedComment } from '../scraper/parser';

export interface DownloadTask {
  url: string;
  destPath: string;
  postId: string;
  mediaType: 'image' | 'video' | 'livephoto' | 'audio';
}

export class MediaDownloader {
  private limit: number;
  private activeBar: cliProgress.SingleBar | null = null;
  private totalTasks = 0;
  private completedTasks = 0;

  constructor() {
    this.limit = config.CONCURRENT_DOWNLOADS;
  }

  /**
   * Initializes or updates the progress bar
   */
  private updateProgress(): void {
    if (!this.activeBar) {
      this.activeBar = new cliProgress.SingleBar({
        format: 'Media Downloads | {bar} | {percentage}% | {value}/{total} Files | Speed: {speed} | {status}',
        barCompleteChar: '\u2588',
        barIncompleteChar: '\u2591',
        hideCursor: true
      }, cliProgress.Presets.shades_classic);
      this.activeBar.start(this.totalTasks, this.completedTasks, { speed: 'N/A', status: 'Downloading...' });
    } else {
      this.activeBar.setTotal(this.totalTasks);
      this.activeBar.update(this.completedTasks, { status: 'Downloading...' });
    }
  }

  /**
   * Complete the progress bar tracking and reset task counters
   */
  private finishProgress(): void {
    if (this.activeBar) {
      this.activeBar.update(this.completedTasks, { status: 'Complete!' });
      this.activeBar.stop();
      this.activeBar = null;
    }
    this.totalTasks = 0;
    this.completedTasks = 0;
  }

  /**
   * Robust worker-queue concurrency limiter running up to `limit` tasks in parallel.
   * Completely eliminates array splice(-1) index bugs and race conditions.
   */
  private async runWithLimit<T>(limit: number, items: T[], fn: (item: T) => Promise<any>): Promise<any[]> {
    if (items.length === 0) return [];
    const results: any[] = new Array(items.length);
    let index = 0;

    const worker = async () => {
      while (index < items.length) {
        const currentIndex = index++;
        try {
          results[currentIndex] = await fn(items[currentIndex]);
        } catch (err) {
          results[currentIndex] = err;
        }
      }
    };

    const poolSize = Math.max(1, Math.min(limit || 1, items.length));
    const workers = Array.from({ length: poolSize }, () => worker());
    await Promise.all(workers);
    return results;
  }

  /**
   * Downloads all media assets for a post concurrently, returns the list of successfully saved relative paths.
   */
  async downloadPostMedia(
    postId: string,
    cdnImages: string[],
    cdnVideos: string[],
    cdnLivePhotos: string[],
    cdnAudios: string[] = [],
    userDir: string,
    monthSubDir: string,
    isRetweet = false
  ): Promise<{ localImages: string[]; localVideos: string[]; localLivePhotos: string[]; localAudios: string[] }> {
    const tasks: DownloadTask[] = [];

    // Form folders
    const imgDir = path.join(userDir, monthSubDir, 'img');
    const videoDir = path.join(userDir, monthSubDir, 'video');
    const livePhotoDir = path.join(userDir, monthSubDir, 'livephoto');
    const audioDir = path.join(userDir, monthSubDir, 'audio');

    const shouldDownloadImages = isRetweet ? config.DOWNLOAD_RETWEET_IMAGES : config.DOWNLOAD_ORIGINAL_IMAGES;
    const shouldDownloadVideos = isRetweet ? config.DOWNLOAD_RETWEET_VIDEOS : config.DOWNLOAD_ORIGINAL_VIDEOS;
    const shouldDownloadLivePhotos = isRetweet ? config.DOWNLOAD_RETWEET_LIVEPHOTOS : config.DOWNLOAD_ORIGINAL_LIVEPHOTOS;
    const shouldDownloadAudios = isRetweet ? config.DOWNLOAD_RETWEET_AUDIOS : config.DOWNLOAD_ORIGINAL_AUDIOS;

    // Queue images
    if (shouldDownloadImages) {
      for (const url of cdnImages) {
        const filename = this.getFilenameFromUrl(url, '.jpg');
        tasks.push({
          url,
          destPath: path.join(imgDir, filename),
          postId,
          mediaType: 'image'
        });
      }
    }

    // Queue videos
    if (shouldDownloadVideos) {
      for (const url of cdnVideos) {
        const filename = this.getFilenameFromUrl(url, '.mp4');
        tasks.push({
          url,
          destPath: path.join(videoDir, filename),
          postId,
          mediaType: 'video'
        });
      }
    }

    // Queue live photos
    if (shouldDownloadLivePhotos) {
      for (const url of cdnLivePhotos) {
        const filename = this.getFilenameFromUrl(url, '.mov');
        tasks.push({
          url,
          destPath: path.join(livePhotoDir, filename),
          postId,
          mediaType: 'livephoto'
        });
      }
    }

    // Queue audios
    if (shouldDownloadAudios) {
      for (const url of cdnAudios) {
        const filename = this.getFilenameFromUrl(url, '.aac');
        tasks.push({
          url,
          destPath: path.join(audioDir, filename),
          postId,
          mediaType: 'audio'
        });
      }
    }

    if (tasks.length === 0) {
      return { localImages: [], localVideos: [], localLivePhotos: [], localAudios: [] };
    }

    // Increment progress counts
    this.totalTasks += tasks.length;
    this.updateProgress();

    const localImages: string[] = [];
    const localVideos: string[] = [];
    const localLivePhotos: string[] = [];
    const localAudios: string[] = [];

    // Run parallel downloads
    await this.runWithLimit(this.limit, tasks, async (task) => {
      const sub = task.mediaType === 'image' ? 'img' : task.mediaType === 'video' ? 'video' : task.mediaType === 'livephoto' ? 'livephoto' : 'audio';
      const relativePath = path.join(monthSubDir, sub, path.basename(task.destPath)).replace(/\\/g, '/');
      
      const success = await this.downloadWithRetry(task.url, task.destPath);
      if (success) {
        if (task.mediaType === 'image') {
          localImages.push(relativePath);
        } else if (task.mediaType === 'video') {
          localVideos.push(relativePath);
        } else if (task.mediaType === 'livephoto') {
          localLivePhotos.push(relativePath);
        } else if (task.mediaType === 'audio') {
          localAudios.push(relativePath);
        }
      }
      this.completedTasks++;
      this.updateProgress();
    });

    if (this.completedTasks >= this.totalTasks) {
      this.finishProgress();
    }

    return { localImages, localVideos, localLivePhotos, localAudios };
  }

  /**
   * Downloads media assets for comments concurrently, returns local relative paths mapped by comment id.
   */
  async downloadCommentMedia(
    comments: ParsedComment[],
    userDir: string,
    monthSubDir: string
  ): Promise<Map<string, string>> {
    const tasks: DownloadTask[] = [];
    const commentIdToDestMap = new Map<string, string>();

    // Form folder
    const commentImgDir = path.join(userDir, monthSubDir, 'comment_img');

    // Queue comment images
    if (config.DOWNLOAD_COMMENT_MEDIA) {
      for (const comment of comments) {
        if (comment.cdn_image) {
          const filename = this.getFilenameFromUrl(comment.cdn_image, '.jpg');
          const destPath = path.join(commentImgDir, filename);
          tasks.push({
            url: comment.cdn_image,
            destPath,
            postId: comment.post_id,
            mediaType: 'image'
          });
          commentIdToDestMap.set(comment.id, destPath);
        }
      }
    }

    if (tasks.length === 0) {
      return new Map();
    }

    // Increment progress counts
    this.totalTasks += tasks.length;
    this.updateProgress();

    const commentIdToRelativePathMap = new Map<string, string>();

    // Run parallel downloads
    await this.runWithLimit(this.limit, tasks, async (task) => {
      // Relative path to store in DB / metadata
      const relativePath = path.join(monthSubDir, 'comment_img', path.basename(task.destPath)).replace(/\\/g, '/');
      const success = await this.downloadWithRetry(task.url, task.destPath);
      if (success) {
        // Find which comment this task belongs to
        for (const [commentId, dest] of commentIdToDestMap.entries()) {
          if (dest === task.destPath) {
            commentIdToRelativePathMap.set(commentId, relativePath);
          }
        }
      }
      this.completedTasks++;
      this.updateProgress();
    });

    if (this.completedTasks >= this.totalTasks) {
      this.finishProgress();
    }

    return commentIdToRelativePathMap;
  }

  /**
   * Core download runner with exponential backoff retries and Referer configuration.
   */
  private async downloadWithRetry(url: string, destPath: string, maxAttempts = 3): Promise<boolean> {
    const dir = path.dirname(destPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    // Skip if already exists and is not zero-byte
    if (fs.existsSync(destPath) && fs.statSync(destPath).size > 0) {
      return true;
    }

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        const response = await fetch(url, {
          signal: AbortSignal.timeout(60000),
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
            'Referer': 'https://weibo.com/',
          }
        });

        if (!response.ok) {
          throw new Error(`Server returned HTTP ${response.status} ${response.statusText}`);
        }

        if (!response.body) {
          throw new Error('Response body is empty');
        }

        const writeStream = fs.createWriteStream(destPath);
        await pipeline(Readable.fromWeb(response.body as any), writeStream);
        
        return true;
      } catch (err: any) {
        // Clean up partial corrupt file immediately on failure
        if (fs.existsSync(destPath)) {
          try { fs.unlinkSync(destPath); } catch {}
        }

        const waitTime = 1000 * Math.pow(2, attempt);
        logger.warn(`Failed download attempt ${attempt}/${maxAttempts} for URL: ${url}. Error: ${err.message}. Retrying in ${waitTime}ms...`);
        
        if (attempt === maxAttempts) {
          logger.error(`Failed to download file after ${maxAttempts} attempts: ${url}`);
          return false;
        }
        
        await new Promise(resolve => setTimeout(resolve, waitTime));
      }
    }
    return false;
  }

  /**
   * Resolves clean filenames from URL paths, or returns md5 hash fallback.
   */
  private getFilenameFromUrl(urlStr: string, defaultExt: string): string {
    try {
      // 1. For Live Photos, attempt to extract the authentic .mov filename from url if present
      if (defaultExt === '.mov') {
        const movMatch = urlStr.match(/([a-zA-Z0-9_\-]+\.mov)/i);
        if (movMatch && movMatch[1]) {
          return movMatch[1];
        }
      }

      // 2. For MP4 videos, attempt to extract authentic .mp4 filename if present
      if (defaultExt === '.mp4') {
        const mp4Match = urlStr.match(/([a-zA-Z0-9_\-]+\.mp4)/i);
        if (mp4Match && mp4Match[1]) {
          return mp4Match[1];
        }
      }

      // 3. For Audio files, attempt to extract authentic audio filename if present
      if (defaultExt === '.aac' || defaultExt === '.mp3') {
        const audioMatch = urlStr.match(/([a-zA-Z0-9_\-]+\.(?:aac|mp3|m4a|wav))/i);
        if (audioMatch && audioMatch[1]) {
          return audioMatch[1];
        }
      }

      const parsed = new URL(urlStr);
      let filename = path.basename(parsed.pathname);
      if (filename.includes('?')) {
        filename = filename.split('?')[0];
      }
      try {
        filename = decodeURIComponent(filename);
      } catch {}

      if (!filename) {
        const hash = crypto.createHash('md5').update(urlStr).digest('hex').substring(0, 10);
        filename = `${hash}${defaultExt}`;
      } else if (!filename.includes('.')) {
        filename = `${filename}${defaultExt}`;
      } else if (defaultExt === '.mov' && !filename.toLowerCase().endsWith('.mov')) {
        const ext = path.extname(filename);
        filename = ext ? filename.substring(0, filename.length - ext.length) + '.mov' : `${filename}.mov`;
      }

      return filename;
    } catch (err) {
      const hash = crypto.createHash('md5').update(urlStr).digest('hex').substring(0, 10);
      return `${hash}${defaultExt}`;
    }
  }
}
