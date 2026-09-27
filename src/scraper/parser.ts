import { logger } from '../utils/logger';

export interface ParsedPost {
  id: string;
  time: string;
  content: string;
  reposts_count: number;
  comments_count: number;
  attitudes_count: number;
  device: string;
  ip_location: string;
  cdn_images: string[];
  local_images: string[];
  cdn_videos: string[];
  local_videos: string[];
  cdn_livephotos: string[];
  local_livephotos: string[];
  cdn_audios: string[];
  local_audios: string[];
  audio_transcript?: string;
  is_retweet: boolean;
  retweeted_id?: string | null;
  retweeted_user?: string | null;
  retweeted_content?: string | null;
  user_id?: string;
  user_name?: string;
  raw: any;
}

export interface ParsedComment {
  id: string;
  post_id: string;
  time: string;
  content: string;
  user_id: string;
  user_name: string;
  ip_location: string;
  like_count: number;
  parent_id?: string | null; // Null if it is a main comment, ID of parent comment if it is floor-in-floor
  cdn_image?: string | null;
  local_image?: string | null;
  raw: any;
}

/**
 * Clean HTML markup, replace custom image emojis with their text alternatives (alt tag), and decode entities.
 */
export function cleanHtmlText(html: string): string {
  if (!html) return '';
  // 1. Replace emoji <img> tags with their alt attribute (e.g. alt="[狗头]")
  let text = html.replace(/<img[^>]*alt=["']([^"']*)["'][^>]*>/gi, '$1');
  // 2. Replace <br> with newlines
  text = text.replace(/<br\s*\/?>/gi, '\n');
  // 3. Strip all other HTML tags
  text = text.replace(/<[^>]+>/g, '');
  // 4. Decode HTML entities
  text = text
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
  return text.trim();
}

/**
 * Format a Date object to Beijing Time (UTC+8) ISO string: YYYY-MM-DDTHH:mm:ss+08:00
 */
export function formatBeijingISO(d: Date): string {
  const beijingMs = d.getTime() + 8 * 3600 * 1000;
  const beijingDate = new Date(beijingMs);
  const pad = (n: number) => String(n).padStart(2, '0');
  const y = beijingDate.getUTCFullYear();
  const m = pad(beijingDate.getUTCMonth() + 1);
  const day = pad(beijingDate.getUTCDate());
  const h = pad(beijingDate.getUTCHours());
  const min = pad(beijingDate.getUTCMinutes());
  const s = pad(beijingDate.getUTCSeconds());
  return `${y}-${m}-${day}T${h}:${min}:${s}+08:00`;
}

/**
 * Converts Weibo's date format (e.g. "Sun Jun 30 15:30:00 +0800 2026") into Beijing Time (UTC+8) ISO string.
 */
export function parseWeiboDate(dateStr: string): string {
  if (!dateStr) return formatBeijingISO(new Date());
  try {
    const d = new Date(dateStr);
    if (!isNaN(d.getTime())) {
      return formatBeijingISO(d);
    }
  } catch (err) {
    logger.warn(`Failed to parse date string: ${dateStr}, using current time.`);
  }
  return formatBeijingISO(new Date());
}

/**
 * Parse a raw post status object returned from Weibo API.
 */
export function parsePost(raw: any): ParsedPost {
  const id = raw.idstr || raw.mid || '';
  const time = parseWeiboDate(raw.created_at);
  logger.info(`[时间解析] 微博 ${id}: 原始 created_at="${raw.created_at}", 转换后 time="${time}"`);
  
  // Decide which text to use. If isLongText, the caller will replace this content with the full text.
  let content = raw.text_raw || cleanHtmlText(raw.text || '');

  const reposts_count = raw.reposts_count || 0;
  const comments_count = raw.comments_count || 0;
  const attitudes_count = raw.attitudes_count || 0;
  const device = cleanHtmlText(raw.source || '');
  const ip_location = raw.region_name ? raw.region_name.replace('发布于 ', '') : '';

  // Media extraction (check root or retweeted nested content)
  const is_retweet = !!raw.retweeted_status;
  let retweeted_id: string | null = null;
  let retweeted_user: string | null = null;
  let retweeted_content: string | null = null;
  
  // Extract media URLs
  let mediaSource = raw;
  if (is_retweet && raw.retweeted_status) {
    const rt = raw.retweeted_status;
    retweeted_id = rt.idstr || rt.mid || null;
    retweeted_user = rt.user?.screen_name || null;
    // Check if retweet is deleted
    if (rt.text || rt.text_raw) {
      retweeted_content = rt.text_raw || cleanHtmlText(rt.text || '');
      mediaSource = rt;
    } else {
      retweeted_content = '[原微博已删除]';
      mediaSource = {}; // empty media source
    }
  }

  const { images, videos, livePhotos, audios, audioTranscript } = extractMedia(mediaSource);

  return {
    id,
    time,
    content,
    reposts_count,
    comments_count,
    attitudes_count,
    device,
    ip_location,
    cdn_images: images,
    local_images: [], // filled by MediaDownloader
    cdn_videos: videos,
    local_videos: [], // filled by MediaDownloader
    cdn_livephotos: livePhotos,
    local_livephotos: [], // filled by MediaDownloader
    cdn_audios: audios,
    local_audios: [], // filled by MediaDownloader
    audio_transcript: audioTranscript,
    is_retweet,
    retweeted_id,
    retweeted_user,
    retweeted_content,
    raw
  };
}

/**
 * Helper to extract best quality video url from a media_info object
 */
function extractBestVideoUrl(media: any): string | null {
  if (!media) return null;
  let videoUrl = '';

  // 1. Check playback list (holds mp4 versions with resolutions/bitrates)
  if (media.playback_list && Array.isArray(media.playback_list) && media.playback_list.length > 0) {
    let maxResolution = 0;
    let maxBitrate = 0;
    for (const item of media.playback_list) {
      const playInfo = item?.play_info;
      if (!playInfo?.url) continue;

      const w = playInfo.width || 0;
      const h = playInfo.height || 0;
      const res = w * h;
      const bitrate = playInfo.bitrate || 0;

      if (res > maxResolution || (res === maxResolution && bitrate > maxBitrate)) {
        maxResolution = res;
        maxBitrate = bitrate;
        videoUrl = playInfo.url;
      }
    }
  }

  // 2. Fallbacks
  if (!videoUrl) {
    videoUrl = media.stream_url_hd || media.stream_url || '';
  }

  return videoUrl || null;
}

/**
 * Helper to extract best quality image url from a picture object
 */
function extractBestImageUrl(pic: any): string | null {
  if (!pic) return null;
  return pic.largest?.url || pic.mw2000?.url || pic.large?.url || pic.original?.url || pic.bmiddle?.url || null;
}

/**
 * Helper to extract media elements from status object, supporting traditional pic_infos/page_info,
 * new mix_media_info (for >9 pictures or mixed media/Live Photos), and pic_ids fallback.
 */
function extractMedia(status: any): { images: string[]; videos: string[]; livePhotos: string[]; audios: string[]; audioTranscript?: string } {
  const imagesSet = new Set<string>();
  const videosSet = new Set<string>();
  const livePhotosSet = new Set<string>();
  const audiosSet = new Set<string>();
  let audioTranscript: string | undefined = undefined;

  if (!status) {
    return { images: [], videos: [], livePhotos: [], audios: [] };
  }

  // 0. Extract audio / voice messages if present (e.g. blog_audio)
  if (status.blog_audio && typeof status.blog_audio === 'object') {
    if (status.blog_audio.media_url) {
      audiosSet.add(status.blog_audio.media_url);
    }
    if (status.blog_audio.transcript) {
      audioTranscript = status.blog_audio.transcript;
    }
  }

  // 1. Extract from new mix_media_info structure (Weibo API for >9 images or mixed media)
  if (status.mix_media_info && Array.isArray(status.mix_media_info.items)) {
    for (const item of status.mix_media_info.items) {
      if (!item) continue;
      const type = item.type;
      const data = item.data || item;

      // Extract Audio item if present in mix_media_info
      if (type === 'audio' || data.media_category === 'audio') {
        const audioUrl = data.media_url || data.stream_url || data.url;
        if (audioUrl) audiosSet.add(audioUrl);
        if (data.transcript && !audioTranscript) {
          audioTranscript = data.transcript;
        }
      }

      // Extract Live Photo video stream (.mov) if present
      if (data.video) {
        livePhotosSet.add(data.video);
      }

      // Picture item (or item containing picture assets)
      if (type === 'pic' || (!type && (data.largest || data.mw2000 || data.large || data.pic_id))) {
        const imgUrl = extractBestImageUrl(data);
        if (imgUrl) {
          imagesSet.add(imgUrl);
        } else if (data.pic_id || item.id) {
          imagesSet.add(`https://wx1.sinaimg.cn/large/${data.pic_id || item.id}.jpg`);
        }
      }

      // Video item (or item containing media_info)
      if (type === 'video' || (!type && (data.media_info || item.media_info))) {
        const media = data.media_info || item.media_info || data;
        const videoUrl = extractBestVideoUrl(media);
        if (videoUrl) {
          videosSet.add(videoUrl);
        }
      }
    }
  }

  // 2. Extract from traditional pic_infos (<= 9 pictures)
  if (status.pic_infos) {
    for (const key of Object.keys(status.pic_infos)) {
      const pic = status.pic_infos[key];
      if (!pic) continue;

      // Live photo has standard video link inside the picture info
      if (pic.video) {
        livePhotosSet.add(pic.video);
      }

      const imgUrl = extractBestImageUrl(pic);
      if (imgUrl) {
        imagesSet.add(imgUrl);
      }
    }
  }

  // 3. Extract from traditional page_info.media_info (standard single video posts or audio)
  if (status.page_info?.media_info) {
    if (status.page_info.type === 'audio' || status.page_info.media_category === 'audio') {
      const audioUrl = status.page_info.media_info.stream_url_hd || status.page_info.media_info.stream_url;
      if (audioUrl) audiosSet.add(audioUrl);
    } else {
      const videoUrl = extractBestVideoUrl(status.page_info.media_info);
      if (videoUrl) {
        videosSet.add(videoUrl);
      }
    }
  }

  // 4. Fallback with pic_ids (ensure no images are missed if pic_infos or mix_media_info is absent or partial)
  if (status.pic_ids && Array.isArray(status.pic_ids)) {
    for (const picId of status.pic_ids) {
      if (!picId) continue;
      let alreadyIncluded = false;
      for (const url of imagesSet) {
        if (url.includes(picId)) {
          alreadyIncluded = true;
          break;
        }
      }
      if (!alreadyIncluded) {
        imagesSet.add(`https://wx1.sinaimg.cn/large/${picId}.jpg`);
      }
    }
  }

  return {
    images: Array.from(imagesSet),
    videos: Array.from(videosSet),
    livePhotos: Array.from(livePhotosSet),
    audios: Array.from(audiosSet),
    audioTranscript
  };
}

/**
 * Parse a raw comment object returned from Weibo API.
 */
export function parseComment(raw: any, postId: string, parentId: string | null = null): ParsedComment {
  const id = raw.idstr || raw.id || '';
  const time = parseWeiboDate(raw.created_at);
  const content = raw.text_raw || cleanHtmlText(raw.text || '');
  const user_id = raw.user?.idstr || raw.user?.id || '';
  const user_name = raw.user?.screen_name || '';
  const ip_location = raw.source ? raw.source.replace('来自', '') : '';
  const like_count = raw.like_counts || raw.like_count || 0;

  // Extract comment image (3-layered robust extraction)
  let cdn_image: string | null = null;

  // 1. Extract from url_struct (for links/card images)
  if (raw.url_struct && Array.isArray(raw.url_struct)) {
    for (const item of raw.url_struct) {
      if (item.pic_infos) {
        const picKeys = Object.keys(item.pic_infos);
        for (const picKey of picKeys) {
          const pic = item.pic_infos[picKey];
          const url = pic.woriginal?.url || pic.large?.url || pic.bmiddle?.url || pic.thumbnail?.url;
          if (url) {
            cdn_image = url;
            break;
          }
        }
      }
      if (cdn_image) break;
    }
  }

  // 2. Extract from root-level pic_infos (direct comment images)
  if (!cdn_image && raw.pic_infos) {
    const picKeys = Object.keys(raw.pic_infos);
    for (const picKey of picKeys) {
      const pic = raw.pic_infos[picKey];
      const url = pic.original?.url || pic.woriginal?.url || pic.large?.url || pic.bmiddle?.url || pic.thumbnail?.url;
      if (url) {
        cdn_image = url;
        break;
      }
    }
  }

  // 3. Extract from root-level pic (child comment GIFs/emojis fallback)
  if (!cdn_image && raw.pic) {
    if (typeof raw.pic === 'string') {
      cdn_image = raw.pic;
    } else {
      cdn_image = raw.pic.original?.url || raw.pic.woriginal?.url || raw.pic.large?.url || raw.pic.bmiddle?.url || raw.pic.thumbnail?.url || raw.pic.url || null;
    }
  }

  return {
    id,
    post_id: postId,
    time,
    content,
    user_id,
    user_name,
    ip_location,
    like_count,
    parent_id: parentId,
    cdn_image,
    local_image: null,
    raw
  };
}
