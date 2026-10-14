import knex, { Knex } from 'knex';
import * as path from 'path';
import * as fs from 'fs';
import { config } from '../config';
import { logger } from '../utils/logger';

let dbInstance: Knex | null = null;

/**
 * 规范化并清洗 MySQL 连接配置：
 * 1. 兼容云服务商（如 Aiven, TiDB, RDS）连接串中自带的 ssl-mode / sslmode 参数，防止触发 mysql2 驱动配置警告或未来抛错；
 * 2. 如果配置了 DB_SSL_CA，则自动加载 CA 证书文件并注入安全 SSL 连接选项；
 * 3. 保持与原生 MySQL2 连接配置的完全兼容。
 */
function resolveMysqlConnection(): string | Knex.MySqlConnectionConfig {
  const rawUri = config.DB_URI;
  let sanitizedUri = rawUri;
  let removedSslMode = false;

  try {
    const parsed = new URL(rawUri);
    if (parsed.searchParams.has('ssl-mode')) {
      parsed.searchParams.delete('ssl-mode');
      removedSslMode = true;
    }
    if (parsed.searchParams.has('sslmode')) {
      parsed.searchParams.delete('sslmode');
      removedSslMode = true;
    }
    sanitizedUri = parsed.toString();
  } catch {
    const cleaned = rawUri
      .replace(/[?&]ssl-mode=[^&]*/gi, '')
      .replace(/[?&]sslmode=[^&]*/gi, '')
      .replace(/\?&/, '?')
      .replace(/\?$/, '');
    if (cleaned !== rawUri) {
      sanitizedUri = cleaned;
      removedSslMode = true;
    }
  }

  if (removedSslMode) {
    logger.info('已自动处理并剥离 MySQL 连接串中不被 mysql2 驱动直接支持的 ssl-mode 参数，避免触发驱动警告。');
  }

  // 检查是否配置了自定义 SSL CA 证书
  if (config.DB_SSL_CA) {
    const caPath = path.isAbsolute(config.DB_SSL_CA)
      ? config.DB_SSL_CA
      : path.resolve(process.cwd(), config.DB_SSL_CA);
    if (fs.existsSync(caPath)) {
      logger.info(`已加载自定义 MySQL SSL CA 证书: ${caPath}`);
      return {
        uri: sanitizedUri,
        ssl: {
          ca: fs.readFileSync(caPath),
          rejectUnauthorized: config.DB_SSL_REJECT_UNAUTHORIZED,
        },
      } as any;
    } else {
      logger.warn(`指定的 DB_SSL_CA 证书文件不存在: ${caPath}，将使用连接串默认设置。`);
    }
  }

  return sanitizedUri;
}

/**
 * 规范化并清洗 PostgreSQL 连接配置：
 * 1. 兼容云服务商（如 Aiven, Supabase, Neon）连接串中自带的 sslmode / ssl-mode 参数；
 * 2. 剥离 query 中的 sslmode，避免 pg 驱动内部覆盖 rejectUnauthorized 选项并引发 self-signed certificate in certificate chain 错误；
 * 3. 支持 DB_SSL_REJECT_UNAUTHORIZED（默认为 false 兼容云端自签名证书）；
 * 4. 支持 DB_SSL_CA 自定义证书加载。
 */
function resolvePostgresConnection(): string | Knex.PgConnectionConfig {
  const rawUri = config.DB_URI;
  let sanitizedUri = rawUri;
  let hasSslParam = false;

  try {
    const parsed = new URL(rawUri);
    if (parsed.searchParams.has('sslmode')) {
      parsed.searchParams.delete('sslmode');
      hasSslParam = true;
    }
    if (parsed.searchParams.has('ssl-mode')) {
      parsed.searchParams.delete('ssl-mode');
      hasSslParam = true;
    }
    sanitizedUri = parsed.toString();
  } catch {
    const cleaned = rawUri
      .replace(/[?&]sslmode=[^&]*/gi, '')
      .replace(/[?&]ssl-mode=[^&]*/gi, '')
      .replace(/\?&/, '?')
      .replace(/\?$/, '');
    if (cleaned !== rawUri) {
      sanitizedUri = cleaned;
      hasSslParam = true;
    }
  }

  // 构建 SSL 配置
  let sslConfig: any = false;

  if (config.DB_SSL_CA) {
    const caPath = path.isAbsolute(config.DB_SSL_CA)
      ? config.DB_SSL_CA
      : path.resolve(process.cwd(), config.DB_SSL_CA);
    if (fs.existsSync(caPath)) {
      logger.info(`已加载自定义 PostgreSQL SSL CA 证书: ${caPath}`);
      sslConfig = {
        ca: fs.readFileSync(caPath),
        rejectUnauthorized: config.DB_SSL_REJECT_UNAUTHORIZED,
      };
    } else {
      logger.warn(`指定的 DB_SSL_CA 证书文件不存在: ${caPath}，将使用基础 SSL 设置。`);
      sslConfig = {
        rejectUnauthorized: config.DB_SSL_REJECT_UNAUTHORIZED,
      };
    }
  } else if (hasSslParam || rawUri.includes('sslmode') || rawUri.includes('ssl-mode')) {
    sslConfig = {
      rejectUnauthorized: config.DB_SSL_REJECT_UNAUTHORIZED,
    };
  }

  if (sslConfig !== false) {
    if (hasSslParam) {
      logger.info(`已自动规范化 PostgreSQL 连接参数并配置安全连接 (rejectUnauthorized=${config.DB_SSL_REJECT_UNAUTHORIZED})。`);
    }
    return {
      connectionString: sanitizedUri,
      ssl: sslConfig,
    } as any;
  }

  return sanitizedUri;
}

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
      connection: resolveMysqlConnection() as any,
    };
    logger.info(`Database connection initialized for MySQL.`);
  } else if (config.DB_TYPE === 'postgres') {
    dbConfig = {
      client: 'pg',
      connection: resolvePostgresConnection() as any,
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

  // Create user_profiles table
  const hasProfiles = await db.schema.hasTable('user_profiles');
  if (!hasProfiles) {
    await db.schema.createTable('user_profiles', (table) => {
      table.string('uid').primary();
      table.string('screen_name');
      table.string('gender');
      table.string('birthday');
      table.string('constellation');
      table.string('location');
      table.string('ip_location');
      table.text('education');
      table.text('career');
      table.string('sunshine_credit');
      table.string('created_at_weibo');
      table.boolean('verified');
      table.string('verified_type');
      table.string('verified_reason');
      table.string('real_auth');
      table.integer('followers_count');
      table.integer('friends_count');
      table.integer('statuses_count');
      table.string('total_cnt');
      table.text('description');
      table.string('avatar_url');
      table.string('avatar_local');
      table.string('cover_phone_url');
      table.string('cover_phone_local');
      table.string('cover_web_url');
      table.string('cover_web_local');
      table.text('raw_json');
      table.timestamps(true, true);
    });
    logger.info('Table "user_profiles" created.');
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

export async function upsertUserProfile(db: Knex, profile: any): Promise<void> {
  await initializeSchema(db);
  const existing = await db('user_profiles').where({ uid: profile.uid }).first();
  const dbData = {
    uid: profile.uid,
    screen_name: profile.screenName,
    gender: profile.gender,
    birthday: profile.birthday || '',
    constellation: profile.constellation || '',
    location: profile.location || '',
    ip_location: profile.ipLocation || '',
    education: profile.education || '',
    career: profile.career || '',
    sunshine_credit: profile.sunshineCredit || '',
    created_at_weibo: profile.createdAt || '',
    verified: profile.verified,
    verified_type: profile.verifiedType || '',
    verified_reason: profile.verifiedReason || '',
    real_auth: profile.realAuth || '',
    followers_count: profile.followersCount || 0,
    friends_count: profile.friendsCount || 0,
    statuses_count: profile.statusesCount || 0,
    total_cnt: profile.totalInteractions || '',
    description: profile.description || '',
    avatar_url: profile.media?.avatarUrl || '',
    avatar_local: profile.media?.avatarLocalPath || '',
    cover_phone_url: profile.media?.coverPhoneUrl || '',
    cover_phone_local: profile.media?.coverPhoneLocalPath || '',
    cover_web_url: profile.media?.coverWebUrl || '',
    cover_web_local: profile.media?.coverWebLocalPath || '',
    raw_json: JSON.stringify({ rawInfo: profile.rawInfo, rawDetail: profile.rawDetail })
  };

  if (existing) {
    await db('user_profiles').where({ uid: profile.uid }).update({
      ...dbData,
      updated_at: new Date()
    });
  } else {
    await db('user_profiles').insert({
      ...dbData,
      created_at: new Date(),
      updated_at: new Date()
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
