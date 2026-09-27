import knex, { Knex } from 'knex';
import * as path from 'path';
import * as fs from 'fs';
import { config } from '../config';
import { logger } from '../utils/logger';

let dbInstance: Knex | null = null;

export function getDb(): Knex {
  if (dbInstance) return dbInstance;

  let dbConfig: Knex.Config;

  if (config.DB_TYPE === 'sqlite') {
    const dbPath = path.isAbsolute(config.DB_URI) 
      ? config.DB_URI 
      : path.resolve(process.cwd(), config.DB_URI);
    
    // Create folder for SQLite file if it doesn't exist
    const dir = path.dirname(dbPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    dbConfig = {
      client: 'better-sqlite3',
      connection: {
        filename: dbPath,
      },
      useNullAsDefault: true,
    };
    logger.info(`Database connection initialized for SQLite at: ${dbPath}`);
  } else if (config.DB_TYPE === 'mysql') {
    dbConfig = {
      client: 'mysql2',
      connection: config.DB_URI,
    };
    logger.info(`Database connection initialized for MySQL.`);
  } else if (config.DB_TYPE === 'postgres') {
    dbConfig = {
      client: 'pg',
      connection: config.DB_URI,
    };
    logger.info(`Database connection initialized for PostgreSQL.`);
  } else {
    throw new Error(`Unsupported database type: ${config.DB_TYPE}`);
  }

  dbInstance = knex(dbConfig);
  return dbInstance;
}

export async function initializeSchema(db: Knex): Promise<void> {
  // Create posts table
  const hasPosts = await db.schema.hasTable('posts');
  if (!hasPosts) {
    await db.schema.createTable('posts', (table) => {
      table.string('id').primary();
      table.string('user_id');
      table.string('user_name');
      table.string('time');
      table.text('content');
      table.integer('reposts_count');
      table.integer('comments_count');
      table.integer('attitudes_count');
      table.string('device');
      table.string('ip_location');
      table.text('cdn_images');
      table.text('local_images');
      table.text('cdn_videos');
      table.text('local_videos');
      table.text('cdn_livephotos');
      table.text('local_livephotos');
      table.text('cdn_audios');
      table.text('local_audios');
      table.text('audio_transcript');
      table.boolean('is_retweet');
      table.string('retweeted_id');
      table.string('retweeted_user');
      table.text('retweeted_content');
      table.timestamps(true, true);
    });
    logger.info('Table "posts" created.');
  } else {
    // Migration: check if audio columns exist in existing posts table
    const hasAudiosCol = await db.schema.hasColumn('posts', 'local_audios');
    if (!hasAudiosCol) {
      await db.schema.alterTable('posts', (table) => {
        table.text('cdn_audios');
        table.text('local_audios');
        table.text('audio_transcript');
      });
      logger.info('Migrated table "posts": added audio columns.');
    }
  }

  // Create comments table
  const hasComments = await db.schema.hasTable('comments');
  if (!hasComments) {
    await db.schema.createTable('comments', (table) => {
      table.string('id').primary();
      table.string('post_id');
      table.string('parent_id');
      table.string('time');
      table.text('content');
      table.string('user_id');
      table.string('user_name');
      table.string('ip_location');
      table.integer('like_count');
      table.string('cdn_image');
      table.string('local_image');
      table.timestamps(true, true);
    });
    logger.info('Table "comments" created.');
  }
}

export async function upsertPost(db: Knex, post: any): Promise<void> {
  const existing = await db('posts').where({ id: post.id }).first();
  const dbData = {
    id: post.id,
    user_id: post.user_id,
    user_name: post.user_name,
    time: post.time,
    content: post.content,
    reposts_count: post.reposts_count,
    comments_count: post.comments_count,
    attitudes_count: post.attitudes_count,
    device: post.device,
    ip_location: post.ip_location,
    cdn_images: JSON.stringify(post.cdn_images || []),
    local_images: JSON.stringify(post.local_images || []),
    cdn_videos: JSON.stringify(post.cdn_videos || []),
    local_videos: JSON.stringify(post.local_videos || []),
    cdn_livephotos: JSON.stringify(post.cdn_livephotos || []),
    local_livephotos: JSON.stringify(post.local_livephotos || []),
    cdn_audios: JSON.stringify(post.cdn_audios || []),
    local_audios: JSON.stringify(post.local_audios || []),
    audio_transcript: post.audio_transcript || '',
    is_retweet: post.is_retweet,
    retweeted_id: post.retweeted_id,
    retweeted_user: post.retweeted_user,
    retweeted_content: post.retweeted_content,
  };

  if (existing) {
    await db('posts').where({ id: post.id }).update({
      ...dbData,
      updated_at: new Date(),
    });
  } else {
    await db('posts').insert({
      ...dbData,
      created_at: new Date(),
      updated_at: new Date(),
    });
  }
}

export async function upsertComment(db: Knex, comment: any): Promise<void> {
  const existing = await db('comments').where({ id: comment.id }).first();
  const dbData = {
    id: comment.id,
    post_id: comment.post_id,
    parent_id: comment.parent_id,
    time: comment.time,
    content: comment.content,
    user_id: comment.user_id,
    user_name: comment.user_name,
    ip_location: comment.ip_location,
    like_count: comment.like_count,
    cdn_image: comment.cdn_image || null,
    local_image: comment.local_image || null
  };

  if (existing) {
    await db('comments').where({ id: comment.id }).update({
      ...dbData,
      updated_at: new Date(),
    });
  } else {
    await db('comments').insert({
      ...dbData,
      created_at: new Date(),
      updated_at: new Date(),
    });
  }
}

export async function closeDb(): Promise<void> {
  if (dbInstance) {
    await dbInstance.destroy();
    dbInstance = null;
    logger.info('Database connection closed.');
  }
}
