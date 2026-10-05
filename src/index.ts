import { WeiboScraper } from './scraper/WeiboScraper';
import { closeDb } from './storage/db';
import { logger } from './utils/logger';
import { config } from './config';
import { TelegramBot } from './utils/telegramBot';
import { Notifier } from './utils/notifier';
import { sessionManager } from './auth/SessionManager';
// Register global unhandled rejection & exception handlers to protect daemon process
process.on('unhandledRejection', (reason, promise) => {
  logger.error('Unhandled Promise Rejection at:', promise, 'reason:', reason);
});
process.on('uncaughtException', (err) => {
  logger.error('Uncaught Exception:', err);
});

async function start() {
  const args = process.argv;
  const isCrawlArg = args.some(arg => arg === '-c' || arg === '--crawl-post');
  const isDeleteArg = args.some(arg => arg === '-d' || arg === '--delete-post');
  const modeLabel = isCrawlArg ? '命令行定向爬取' : isDeleteArg ? '命令行定向删除' : (config.DAEMON_MODE ? '守护进程' : '单次抓取');

  logger.info(`正在初始化微博爬虫系统... [模式: ${modeLabel}]`);

  // Configure global fetch proxy if set
  if (config.HTTP_PROXY) {
    try {
      const { ProxyAgent, setGlobalDispatcher } = require('undici');
      logger.info(`已设置全局 HTTP 代理为: ${config.HTTP_PROXY}`);
      const dispatcher = new ProxyAgent(config.HTTP_PROXY);
      setGlobalDispatcher(dispatcher);
    } catch (err) {
      logger.error('启动时配置全局 HTTP 代理失败:', err);
    }
  }

  // Register graceful shutdown handlers
  const handleShutdown = async (signal: string) => {
    logger.warn(`收到 ${signal} 信号。正在执行退出...`);
    try {
      sessionManager.stopKeepAlive();
      TelegramBot.stop();
      await closeDb();
      logger.info('退出完毕，结束进程。');
    } catch (err) {
      logger.error('退出时关闭数据库出错:', err);
    }
    process.exit(0);
  };

  process.on('SIGINT', () => handleShutdown('SIGINT'));
  process.on('SIGTERM', () => handleShutdown('SIGTERM'));

  const helpIdx = args.findIndex(arg => arg === '-h' || arg === '--help');
  if (helpIdx > -1) {
    console.log(`
微博爬虫系统命令行帮助手册:

用法:
  node dist/index.js                  默认运行模式 (启动增量同步，或启动 Telegram 交互机器人)
  node dist/index.js -c <日期/微博ID>   定向爬取指定日期或单条微博 (配合 -u 指定博主)
  node dist/index.js -d <日期/微博ID>   定向删除指定日期或单条微博的备份 (配合 -u 指定博主)

选项:
  -c, --crawl-post   定向爬取。值可以是 YYYY-MM-DD 格式日期，或微博链接/MID/BID
  -d, --delete-post  定向物理删除备份。值可以是 YYYY-MM-DD 格式日期，或微博链接/MID/BID
  -u, --uid          指定博主的微博 UID (用于多博主配置时限定 -c/-d 日期操作的目标博主)
  -h, --help         显示此帮助信息
`);
    process.exit(0);
  }

  const crawlIdx = args.findIndex(arg => arg === '-c' || arg === '--crawl-post');
  const deleteIdx = args.findIndex(arg => arg === '-d' || arg === '--delete-post');
  const uidIdx = args.findIndex(arg => arg === '-u' || arg === '--uid');

  const resolvedUid = uidIdx > -1 && args[uidIdx + 1] ? args[uidIdx + 1] : undefined;

  const getBloggerDisplayName = (uid: string): string => {
    try {
      const { readUsers } = require('./utils/userFileHelper');
      const users = readUsers();
      const match = users.find((u: any) => u.uid === uid);
      if (match?.name) return `${match.name} (${uid})`;
    } catch {}
    return uid;
  };

  const getOrResolveUid = (): string => {
    if (resolvedUid) return resolvedUid;
    const { readUsers } = require('./utils/userFileHelper');
    let activeUids: string[] = [];
    const list = config.USER_ID_LIST.trim();
    if (list.toLowerCase().endsWith('.txt')) {
      const users = readUsers();
      activeUids = users.filter((u: any) => !u.isCommented && u.uid).map((u: any) => u.uid!);
    } else {
      activeUids = list.split(',').map(s => s.trim()).filter(Boolean);
    }

    if (activeUids.length === 1) {
      return activeUids[0];
    } else if (activeUids.length === 0) {
      logger.error('❌ 错误：配置中未找到有效的博主 UID。');
      process.exit(1);
    } else {
      logger.error(`❌ 错误：配置中存在多个博主 (${activeUids.join(', ')})。请使用 -u <UID> 或 --uid <UID> 指定目标博主。`);
      process.exit(1);
    }
  };

  if (crawlIdx > -1 && args[crawlIdx + 1]) {
    const target = args[crawlIdx + 1];
    const isDate = /^\d{4}-\d{2}-\d{2}$/.test(target);
    const scraper = new WeiboScraper();
    let res;

    if (isDate) {
      const uid = getOrResolveUid();
      logger.info(`CLI：开始针对 ${getBloggerDisplayName(uid)} 在日期 "${target}" 的定向爬取`);
      res = await scraper.crawlDateForUser(uid, target);
    } else {
      logger.info(`CLI：开始针对微博 "${target}" 的定向单条爬取`);
      res = await scraper.crawlSinglePost(target);
    }

    if (res.success) {
      logger.info(`CLI 运行成功: ${res.message}`);
      await closeDb();
      process.exit(0);
    } else {
      logger.error(`CLI 运行失败: ${res.message}`);
      await closeDb();
      process.exit(1);
    }
  }

  if (deleteIdx > -1 && args[deleteIdx + 1]) {
    const target = args[deleteIdx + 1];
    const isDate = /^\d{4}-\d{2}-\d{2}$/.test(target);
    const { deletePostData, deleteDateData } = require('./storage/deleteUtility');
    let res;

    if (isDate) {
      const uid = getOrResolveUid();
      logger.info(`CLI：开始针对 ${getBloggerDisplayName(uid)} 在日期 "${target}" 的定向物理删除`);
      res = await deleteDateData(uid, target);
    } else {
      logger.info(`CLI：开始针对微博 "${target}" 的定向物理删除`);
      res = await deletePostData(target);
    }

    if (res.success) {
      logger.info(`CLI 运行成功: ${res.message}`);
      await closeDb();
      process.exit(0);
    } else {
      logger.error(`CLI 运行失败: ${res.message}`);
      await closeDb();
      process.exit(1);
    }
  }

  // Check if we should run in Telegram Interactive Daemon Mode
  if (config.DAEMON_MODE) {
    if (config.WEIBO_SESSION_REFRESH_ENABLED) {
      sessionManager.startKeepAlive();
    }
    if (config.TELEGRAM_BOT_TOKEN) {
      try {
        await TelegramBot.start();
      } catch (error: any) {
        logger.error('Telegram 机器人守护进程执行发生致命错误:', error);
        process.exit(1);
      }
    } else {
      logger.warn('已启用守护进程模式 (DAEMON_MODE)，但未配置 Telegram Bot Token。将回退到单次运行模式。');
      await runSingleScrape();
    }
  } else {
    // Normal single-run mode (e.g. for crontabs)
    await runSingleScrape();
  }
}

async function runSingleScrape() {
  const scraper = new WeiboScraper();
  try {
    const summary = await scraper.run();
    await closeDb();
    logger.info('微博爬虫增量同步运行成功！');
    await Notifier.sendText(summary);
  } catch (error: any) {
    logger.error('微博爬虫运行中发生致命错误:', error);
    try {
      await closeDb();
    } catch { }
    await Notifier.sendText(`❌ 微博爬虫运行失败: ${error.message || error}`);
    process.exit(1);
  }
}

start();
