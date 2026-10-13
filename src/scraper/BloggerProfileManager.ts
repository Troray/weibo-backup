import * as fs from 'fs';
import * as path from 'path';
import axios from 'axios';
import { config } from '../config';
import { logger } from '../utils/logger';
import { sessionManager } from '../auth/SessionManager';
import { getAxiosProxyConfig } from '../utils/proxyHelper';
import { isUserListFile, readUsers, writeUsers } from '../utils/userFileHelper';
import { getDb, upsertUserProfile } from '../storage/db';

export interface BloggerProfileMedia {
  avatarUrl: string;
  avatarLocalPath: string;
  coverPhoneUrl: string;
  coverPhoneLocalPath: string;
  coverWebUrl?: string;
  coverWebLocalPath?: string;
}

export interface BloggerProfileData {
  uid: string;
  screenName: string;
  gender: string;
  birthday: string;
  constellation: string;
  location: string;
  ipLocation: string;
  education: string;
  career: string;
  sunshineCredit: string;
  createdAt: string;
  verified: boolean;
  verifiedReason: string;
  verifiedType: string;
  realAuth: string;
  description: string;
  followersCount: number;
  followersCountStr: string;
  friendsCount: number;
  statusesCount: number;
  repostCount: string;
  commentCount: string;
  likeCount: string;
  totalInteractions: string;
  vipInfo: string;
  tags: string[];
  friendInfo: string;
  pageUrl: string;
  blogUrl: string;
  media: BloggerProfileMedia;
  rawInfo?: any;
  rawDetail?: any;
  updatedAt: string;
}

/**
 * 依据月日计算西方十二星座
 */
export function getConstellation(month: number, day: number): string {
  const dates = [20, 19, 21, 20, 21, 22, 23, 23, 23, 24, 22, 22];
  const signs = [
    '摩羯座', '水瓶座', '双鱼座', '白羊座', '金牛座', '双子座',
    '巨蟹座', '狮子座', '处女座', '天秤座', '天蝎座', '射手座', '摩羯座'
  ];
  return day < dates[month - 1] ? signs[month - 1] : signs[month];
}

/**
 * 解析生日与星座
 */
export function parseBirthdayAndConstellation(rawBirthday?: string): { birthday: string; constellation: string } {
  if (!rawBirthday || !rawBirthday.trim()) {
    return { birthday: '', constellation: '' };
  }
  const str = rawBirthday.trim();

  const zodiacs = ['白羊座', '金牛座', '双子座', '巨蟹座', '狮子座', '处女座', '天秤座', '天蝎座', '射手座', '摩羯座', '水瓶座', '双鱼座'];
  let foundZodiac = '';
  for (const z of zodiacs) {
    if (str.includes(z)) {
      foundZodiac = z;
      break;
    }
  }

  let cleanDate = str.replace(foundZodiac, '').trim();
  const dateMatch = cleanDate.match(/(?:(\d{4})[-/年])?(\d{1,2})[-/月](\d{1,2})/);
  if (dateMatch) {
    const month = parseInt(dateMatch[2], 10);
    const day = parseInt(dateMatch[3], 10);
    if (!foundZodiac && month >= 1 && month <= 12 && day >= 1 && day <= 31) {
      foundZodiac = getConstellation(month, day);
    }
  }

  return {
    birthday: cleanDate,
    constellation: foundZodiac
  };
}

/**
 * 解析教育/学习经历
 */
export function parseEducation(edu: any): string {
  if (!edu) return '';
  if (typeof edu === 'string') return edu.trim();
  const list: string[] = [];
  if (Array.isArray(edu)) {
    for (const item of edu) {
      if (typeof item === 'string' && item.trim()) {
        list.push(item.trim());
      } else if (item && typeof item === 'object') {
        const parts = [item.school, item.department, item.time].filter(Boolean);
        if (parts.length > 0) list.push(parts.join(' '));
      }
    }
  } else if (typeof edu === 'object') {
    for (const key of ['college', 'university', 'high_school', 'school']) {
      const val = edu[key];
      if (Array.isArray(val)) {
        for (const item of val) {
          const parts = [item.school, item.department, item.time].filter(Boolean);
          if (parts.length > 0) list.push(parts.join(' '));
        }
      } else if (typeof val === 'string' && val.trim()) {
        list.push(val.trim());
      } else if (val && typeof val === 'object') {
        const parts = [val.school, val.department, val.time].filter(Boolean);
        if (parts.length > 0) list.push(parts.join(' '));
      }
    }
  }
  return list.join('；');
}

/**
 * 解析职业/公司经历
 */
export function parseCareer(career: any, company: any): string {
  const parts: string[] = [];
  if (typeof company === 'string' && company.trim()) {
    parts.push(company.trim());
  }
  if (career) {
    if (typeof career === 'string' && career.trim()) {
      if (!parts.includes(career.trim())) parts.push(career.trim());
    } else if (typeof career === 'object') {
      if (career.company && typeof career.company === 'string' && !parts.includes(career.company.trim())) {
        parts.push(career.company.trim());
      }
      if (career.position && typeof career.position === 'string') {
        parts.push(career.position.trim());
      }
    }
  }
  return parts.join(' - ');
}

/**
 * 格式化性别
 */
export function formatGender(gender?: string): string {
  if (gender === 'm' || gender === '男') return '男 ♂';
  if (gender === 'f' || gender === '女') return '女 ♀';
  return '未公开';
}

/**
 * 解析认证类型描述
 */
export function getVerifiedTypeDesc(verified: boolean, verifiedType?: number, verifiedTypeExt?: number): string {
  if (!verified) return '未认证';
  if (verifiedType === 0) {
    return verifiedTypeExt === 1 ? '黄V认证 (核心头部博主)' : '微博个人认证 (黄V)';
  }
  if (verifiedType === 1 || verifiedType === 2 || verifiedType === 3) {
    return '微博官方机构/企业认证 (蓝V)';
  }
  if (verifiedType === 220) {
    return '微博达人认证';
  }
  return '微博认证用户';
}

/**
 * 格式化 VIP 会员信息
 */
export function formatVipInfo(user: any): string {
  const parts: string[] = [];
  if (user?.svip) parts.push(`SVIP${user.svip}`);
  if (user?.vvip) parts.push(`VVIP${user.vvip}`);
  if (user?.mbrank) parts.push(`VIP等级: ${user.mbrank}`);
  return parts.length > 0 ? parts.join(' | ') : '普通用户';
}

/**
 * 格式化实名认证状态
 */
export function formatRealAuth(detail: any): string {
  if (detail?.real_auth === true) {
    if (detail.real_name?.name) {
      return `已认证 (${detail.real_name.name})`;
    }
    return '已认证';
  } else if (detail?.real_auth === false) {
    return '未认证';
  }
  return '未公开';
}

export class BloggerProfileManager {
  private static instance: BloggerProfileManager;
  private syncedUids = new Set<string>();

  public static getInstance(): BloggerProfileManager {
    if (!BloggerProfileManager.instance) {
      BloggerProfileManager.instance = new BloggerProfileManager();
    }
    return BloggerProfileManager.instance;
  }

  /**
   * 从微博服务端拉取博主的主页概要与详细资料
   */
  public async fetchRawProfile(uid: string): Promise<{ info: any; detail: any } | null> {
    const infoUrl = `https://weibo.com/ajax/profile/info?uid=${uid}`;
    const detailUrl = `https://weibo.com/ajax/profile/detail?uid=${uid}`;

    let infoData: any = null;
    let detailData: any = null;

    try {
      logger.info(`正在请求博主 (${uid}) 的基础资料 (ajax/profile/info)...`);
      const resInfo = await axios({
        url: infoUrl,
        method: 'GET',
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          'Referer': `https://weibo.com/u/${uid}`,
          'Cookie': sessionManager.getCookieHeader(infoUrl)
        },
        proxy: getAxiosProxyConfig(),
        timeout: 15000
      });
      infoData = resInfo.data;
    } catch (err: any) {
      logger.warn(`获取博主 (${uid}) 的 profile/info 失败: ${err.message}`);
    }

    try {
      logger.info(`正在请求博主 (${uid}) 的详细档案 (ajax/profile/detail)...`);
      const resDetail = await axios({
        url: detailUrl,
        method: 'GET',
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          'Referer': `https://weibo.com/u/${uid}`,
          'Cookie': sessionManager.getCookieHeader(detailUrl)
        },
        proxy: getAxiosProxyConfig(),
        timeout: 15000
      });
      detailData = resDetail.data;
    } catch (err: any) {
      logger.warn(`获取博主 (${uid}) 的 profile/detail 失败: ${err.message}`);
    }

    if (!infoData && !detailData) {
      return null;
    }

    return { info: infoData, detail: detailData };
  }

  /**
   * 下载媒体文件（头像、手机背景、网页背景），使用原子重命名防范损坏
   */
  private async downloadMediaFile(url: string, targetPath: string): Promise<boolean> {
    if (!url) return false;
    const dir = path.dirname(targetPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    // 若本地已有非空文件，跳过下载，杜绝重复网络流量
    if (fs.existsSync(targetPath) && fs.statSync(targetPath).size > 0) {
      return true;
    }

    const tempPath = `${targetPath}.tmp.${Date.now()}`;
    try {
      const response = await axios({
        url,
        method: 'GET',
        responseType: 'arraybuffer',
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          'Referer': 'https://weibo.com/'
        },
        proxy: getAxiosProxyConfig(),
        timeout: 20000
      });

      if (response.status === 200 && response.data) {
        fs.writeFileSync(tempPath, Buffer.from(response.data));
        fs.renameSync(tempPath, targetPath);
        return true;
      }
      return false;
    } catch (err: any) {
      if (fs.existsSync(tempPath)) {
        try { fs.unlinkSync(tempPath); } catch {}
      }
      logger.warn(`下载博主资料媒体失败 (${url}): ${err.message}`);
      return false;
    }
  }

  /**
   * 确保博主资料（例如 用户ID.txt 及 profile/ 头像与背景图片）已生成并保存
   * 如果该资料文件已存在，则自动跳过，绝不重复下载与保存。
   * 
   * @param uid 目标博主数字 UID
   * @param knownScreenName 已知的博主昵称（可选）
   * @param options.force 是否强制重新从网络拉取并刷新（默认 false）
   */
  public async ensureBloggerProfile(
    uid: string,
    knownScreenName?: string,
    options?: { force?: boolean }
  ): Promise<BloggerProfileData | null> {
    if (!uid) return null;

    // 1. 进程内缓存：如果本次程序运行中已处理过该 UID，直接跳过
    if (!options?.force && this.syncedUids.has(uid)) {
      return null;
    }

    // 2. 检查本地磁盘是否已存在该博主的资料文件（例如: 用户ID.txt）
    // 2.1 尝试通过 knownScreenName 或 userid.txt 推导博主目录
    let screenName = knownScreenName;
    if (!screenName || screenName === uid || screenName.startsWith('user_')) {
      if (isUserListFile()) {
        const users = readUsers();
        const match = users.find((u: any) => u.uid === uid);
        if (match?.name) {
          screenName = match.name;
        }
      }
    }

    // 2.2 若已知昵称目录，直接检查 OUTPUT_DIR / screenName / <uid>.txt
    if (screenName && !options?.force) {
      const sanitized = screenName.replace(/[\\/:*?"<>|]/g, '_').trim();
      const txtPath = path.join(config.OUTPUT_DIR, sanitized, `${uid}.txt`);
      if (fs.existsSync(txtPath) && fs.statSync(txtPath).size > 0) {
        logger.debug(`博主 (${screenName}) 资料文件已存在 (${txtPath})，跳过重复下载与保存。`);
        this.syncedUids.add(uid);
        return null;
      }
    }

    // 2.3 遍历 OUTPUT_DIR，检查是否已有包含该博主 <uid>.txt 的目录（防范博主更名或不同别名）
    if (!options?.force && fs.existsSync(config.OUTPUT_DIR)) {
      try {
        const entries = fs.readdirSync(config.OUTPUT_DIR, { withFileTypes: true });
        for (const entry of entries) {
          if (entry.isDirectory()) {
            const candidateTxt = path.join(config.OUTPUT_DIR, entry.name, `${uid}.txt`);
            if (fs.existsSync(candidateTxt) && fs.statSync(candidateTxt).size > 0) {
              logger.debug(`博主资料文件已存在 (${candidateTxt})，跳过重复下载与保存。`);
              this.syncedUids.add(uid);
              return null;
            }
          }
        }
      } catch {}
    }

    // 3. 本地不存在该资料文件，初次从微博服务端拉取最新数据
    logger.info(`博主资料文件尚未建立，正在获取博主 UID: ${uid} 的详细资料与背景图片...`);
    const raw = await this.fetchRawProfile(uid);
    if (!raw) {
      logger.warn(`无法从微博接口获取 UID: ${uid} 的博主资料。`);
      this.syncedUids.add(uid);
      return null;
    }

    const user = raw.info?.data?.user || {};
    const detail = raw.detail?.data || {};

    const resolvedScreenName = user.screen_name || screenName || `user_${uid}`;
    const sanitizedScreenName = resolvedScreenName.replace(/[\\/:*?"<>|]/g, '_').trim();
    const userDir = path.join(config.OUTPUT_DIR, sanitizedScreenName);
    const profileMediaDir = path.join(userDir, 'profile');

    if (!fs.existsSync(profileMediaDir)) {
      fs.mkdirSync(profileMediaDir, { recursive: true });
    }

    // 4. 回写最新昵称至本地用户配置表 (userid.txt)
    if (user.screen_name && isUserListFile()) {
      try {
        const users = readUsers();
        const existingUser = users.find((u: any) => u.uid === uid);
        if (existingUser && (!existingUser.name || existingUser.name.startsWith('user_'))) {
          existingUser.name = user.screen_name;
          writeUsers(users);
          logger.info(`已将博主 ${user.screen_name} (${uid}) 昵称同步更新至用户清单`);
        }
      } catch (e) {
        logger.warn('更新用户配置清单昵称时出错:', e);
      }
    }

    // 5. 格式化提取各核心字段
    const gender = formatGender(user.gender || detail.gender);
    const { birthday, constellation } = parseBirthdayAndConstellation(detail.birthday);
    const location = user.location || '未公开';
    const ipLocation = detail.ip_location ? detail.ip_location.replace(/^IP属地[：:]\s*/, '') : '未公开';
    const education = parseEducation(detail.education);
    const career = parseCareer(detail.career, detail.company);
    const sunshineCredit = detail.sunshine_credit?.level || '未公开';
    const createdAt = detail.created_at || '未公开';
    const realAuth = formatRealAuth(detail);
    const verified = !!user.verified;
    const verifiedReason = user.verified_reason || detail.desc_text || '';
    const verifiedType = getVerifiedTypeDesc(verified, user.verified_type, user.verified_type_ext);
    const description = user.description || detail.description || '';
    const followersCount = typeof user.followers_count === 'number' ? user.followers_count : 0;
    const followersCountStr = user.followers_count_str || followersCount.toString();
    const friendsCount = typeof user.friends_count === 'number' ? user.friends_count : 0;
    const statusesCount = typeof user.statuses_count === 'number' ? user.statuses_count : 0;

    const counter = user.status_total_counter || {};
    const repostCount = counter.repost_cnt || '0';
    const commentCount = counter.comment_cnt || '0';
    const likeCount = counter.like_cnt || '0';
    const totalInteractions = counter.total_cnt_format 
      ? `${counter.total_cnt || ''} (${counter.total_cnt_format})` 
      : (counter.total_cnt || '0');

    const vipInfo = formatVipInfo(user);
    const friendInfo = detail.friend_info ? detail.friend_info.replace(/<[^>]+>/g, '') : '';
    const pageUrl = `https://weibo.com/u/${uid}`;
    const blogUrl = user.url || '';

    // 解析标签
    const tags: string[] = [];
    if (Array.isArray(detail.label_desc)) {
      for (const item of detail.label_desc) {
        if (item?.name) tags.push(item.name);
      }
    }
    if (detail.cnt_desc) {
      tags.push(detail.cnt_desc);
    }

    // 6. 下载媒体文件 (头像、手机背景、网页背景)
    const avatarUrl = user.avatar_hd || user.avatar_large || user.profile_image_url || '';
    const rawCoverPhone = user.cover_image_phone || '';
    const rawCoverWeb = user.cover_image || '';

    // 解析网页端超清原画背景大图：
    // 微博 API 通常在 cover_image_phone 返回 /crop.0.0.640.640.640/ 裁剪缩略图，
    // 将其裁剪前缀去除并转为 /large/，即可得到网页端实际展示的超清原画大图（高达 2160x2160 像素）
    let coverWebUrl = '';
    if (rawCoverWeb) {
      coverWebUrl = rawCoverWeb.replace(/\/crop\.[^/]+\//, '/large/');
    } else if (rawCoverPhone) {
      coverWebUrl = rawCoverPhone.replace(/\/crop\.[^/]+\//, '/large/');
    }

    const coverPhoneUrl = rawCoverPhone;

    const avatarLocalPath = path.join('profile', 'avatar.jpg').replace(/\\/g, '/');
    const coverPhoneLocalPath = path.join('profile', 'cover_phone.jpg').replace(/\\/g, '/');
    const coverWebLocalPath = path.join('profile', 'cover_web.jpg').replace(/\\/g, '/');

    if (avatarUrl) {
      logger.info(`正在初次下载博主头像: ${avatarUrl}`);
      await this.downloadMediaFile(avatarUrl, path.join(userDir, 'profile', 'avatar.jpg'));
    }

    let hasCoverWeb = false;
    if (coverWebUrl) {
      logger.info(`正在初次下载网页端主页背景图片 (超清原画): ${coverWebUrl}`);
      hasCoverWeb = await this.downloadMediaFile(coverWebUrl, path.join(userDir, 'profile', 'cover_web.jpg'));
    }

    let hasCoverPhone = false;
    if (coverPhoneUrl) {
      logger.info(`正在初次下载手机端主页背景图片: ${coverPhoneUrl}`);
      hasCoverPhone = await this.downloadMediaFile(coverPhoneUrl, path.join(userDir, 'profile', 'cover_phone.jpg'));
    }

    const updatedAt = new Date().toLocaleString('zh-CN', { hour12: false, timeZone: 'Asia/Shanghai' });

    const profileData: BloggerProfileData = {
      uid,
      screenName: resolvedScreenName,
      gender,
      birthday,
      constellation,
      location,
      ipLocation,
      education,
      career,
      sunshineCredit,
      createdAt,
      verified,
      verifiedReason,
      verifiedType,
      realAuth,
      description,
      followersCount,
      followersCountStr,
      friendsCount,
      statusesCount,
      repostCount,
      commentCount,
      likeCount,
      totalInteractions,
      vipInfo,
      tags,
      friendInfo,
      pageUrl,
      blogUrl,
      media: {
        avatarUrl,
        avatarLocalPath,
        coverPhoneUrl,
        coverPhoneLocalPath: hasCoverPhone ? coverPhoneLocalPath : '',
        coverWebUrl: coverWebUrl || undefined,
        coverWebLocalPath: hasCoverWeb ? coverWebLocalPath : undefined
      },
      rawInfo: raw.info,
      rawDetail: raw.detail,
      updatedAt
    };

    // 7. 保存为单独的纯文本资料文件（例如: OUTPUT_DIR/博主昵称/<用户ID>.txt）
    const textContent = this.generatePlainText(profileData);
    const txtPath = path.join(userDir, `${uid}.txt`);
    fs.writeFileSync(txtPath, textContent, 'utf8');

    // 8. 若启用了数据库，同步保存至 user_profiles 数据表
    if (config.DB_TYPE) {
      try {
        const db = getDb();
        await upsertUserProfile(db, profileData);
        logger.info(`博主资料已成功保存至数据库 (user_profiles 表)`);
      } catch (dbErr) {
        logger.error(`保存博主资料到数据库失败:`, dbErr);
      }
    }

    this.syncedUids.add(uid);
    logger.info(`✅ 博主资料已成功归档至单个文件: ${txtPath}`);
    return profileData;
  }

  /**
   * 生成排版清晰规整的单个文本资料文件内容 (例如 用户ID.txt)
   */
  private generatePlainText(data: BloggerProfileData): string {
    let text = `==================================================\n`;
    text += `博主详细资料\n`;
    text += `==================================================\n`;
    text += `用户id：${data.uid}\n`;
    text += `昵称：${data.screenName}\n`;
    text += `性别：${data.gender}\n`;
    text += `生日：${data.birthday || '未公开'}\n`;
    text += `星座：${data.constellation || '未公开'}\n`;
    text += `所在地：${data.location || '未公开'}\n`;
    text += `IP属地：${data.ipLocation || '未公开'}\n`;
    text += `学习经历：${data.education || '未公开'}\n`;
    text += `工作经历：${data.career || '未公开'}\n`;
    text += `阳光信用：${data.sunshineCredit || '未公开'}\n`;
    text += `注册时间：${data.createdAt || '未公开'}\n`;
    text += `认证信息：${data.verified ? `已认证 (${data.verifiedType})${data.verifiedReason ? ` - ${data.verifiedReason}` : ''}` : '未认证'}\n`;
    text += `实名认证：${data.realAuth || '未公开'}\n`;
    text += `会员等级：${data.vipInfo || '普通用户'}\n\n`;

    text += `【社交与互动数据】\n`;
    text += `粉丝数：${data.followersCountStr} (${data.followersCount.toLocaleString()} 人)\n`;
    text += `关注数：${data.friendsCount} 人\n`;
    text += `微博总数：${data.statusesCount} 条\n`;
    text += `转评赞总数：${data.totalInteractions}\n`;
    text += `  - 累计转发：${data.repostCount}\n`;
    text += `  - 累计评论：${data.commentCount}\n`;
    text += `  - 累计点赞：${data.likeCount}\n`;
    if (data.friendInfo) {
      text += `好友与互动：${data.friendInfo}\n`;
    }
    text += `\n`;

    text += `【个人简介】\n`;
    text += `${data.description || '博主暂未设置个人简介。'}\n\n`;

    text += `【多媒体资源】\n`;
    text += `头像：${data.media.avatarLocalPath || '无'} (在线链接: ${data.media.avatarUrl || '无'})\n`;
    text += `网页端背景图片：${data.media.coverWebLocalPath || '默认背景'} (在线链接: ${data.media.coverWebUrl || '无'})\n`;
    text += `手机端背景图片：${data.media.coverPhoneLocalPath || '无'} (在线链接: ${data.media.coverPhoneUrl || '无'})\n\n`;

    text += `【主页链接】\n`;
    text += `微博主页：${data.pageUrl}\n`;
    if (data.blogUrl) {
      text += `博客/网址：${data.blogUrl}\n`;
    }

    if (data.tags && data.tags.length > 0) {
      text += `\n【荣誉与标签】\n`;
      for (const t of data.tags) {
        text += `- ${t}\n`;
      }
    }

    text += `==================================================\n`;
    text += `资料归档时间：${data.updatedAt}\n`;
    text += `==================================================\n`;

    return text;
  }
}
