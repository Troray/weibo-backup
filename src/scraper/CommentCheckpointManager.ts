import * as fs from 'fs';
import * as path from 'path';
import { config } from '../config';
import { logger } from '../utils/logger';
import { ParsedComment } from './parser';

export interface CommentCheckpoint {
  postId: string;
  uid: string;
  count: number;
  updatedAt: string;
  comments: ParsedComment[];
}

/**
 * 评论抓取断点检查点管理器 (Checkpoint Manager)
 * 用于长耗时、海量评论抓取时的分批暂存与异常/中断恢复，避免突发断电、网络崩溃或中断导致数据全损。
 */
export class CommentCheckpointManager {
  /**
   * 获取检查点目录路径: <OUTPUT_DIR>/.cache/checkpoints/
   */
  public static getCheckpointDir(): string {
    const dir = path.join(config.OUTPUT_DIR, '.cache', 'checkpoints');
    if (!fs.existsSync(dir)) {
      try {
        fs.mkdirSync(dir, { recursive: true });
      } catch (e: any) {
        logger.warn(`创建检查点目录失败: ${dir}`, e);
      }
    }
    return dir;
  }

  /**
   * 获取指定微博的检查点 JSON 文件路径
   */
  public static getCheckpointPath(postId: string): string {
    return path.join(this.getCheckpointDir(), `comments_${postId}.json`);
  }

  /**
   * 读取已有检查点缓存
   */
  public static loadCheckpoint(postId: string): CommentCheckpoint | null {
    const filePath = this.getCheckpointPath(postId);
    if (!fs.existsSync(filePath)) {
      return null;
    }
    try {
      const content = fs.readFileSync(filePath, 'utf8');
      const data = JSON.parse(content) as CommentCheckpoint;
      if (data && Array.isArray(data.comments)) {
        return data;
      }
    } catch (err: any) {
      logger.warn(`读取微博 ${postId} 的检查点失败，将忽略异常旧文件: ${err.message}`);
    }
    return null;
  }

  /**
   * 保存/刷新检查点（采用临时文件 + 原子重命名写入，保障并发与突发中断安全）
   */
  public static saveCheckpoint(postId: string, uid: string, comments: ParsedComment[]): void {
    const dir = this.getCheckpointDir();
    const targetPath = this.getCheckpointPath(postId);
    const tempPath = path.join(dir, `comments_${postId}.tmp`);

    const checkpoint: CommentCheckpoint = {
      postId,
      uid,
      count: comments.length,
      updatedAt: new Date().toISOString(),
      comments
    };

    try {
      fs.writeFileSync(tempPath, JSON.stringify(checkpoint), 'utf8');
      fs.renameSync(tempPath, targetPath);
    } catch (err: any) {
      logger.warn(`保存微博 ${postId} 评论检查点失败: ${err.message}`);
      try {
        if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath);
      } catch {}
    }
  }

  /**
   * 清除检查点（任务顺利完成归档落盘后自动清除）
   */
  public static clearCheckpoint(postId: string): void {
    const targetPath = this.getCheckpointPath(postId);
    try {
      if (fs.existsSync(targetPath)) {
        fs.unlinkSync(targetPath);
      }
    } catch (err: any) {
      logger.warn(`清理微博 ${postId} 检查点文件失败: ${err.message}`);
    }
  }
}
