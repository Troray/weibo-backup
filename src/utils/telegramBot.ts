import { config } from '../config';
import { logger } from './logger';
import { readUsers, addUser, deleteUser, commentUser, setUserCursor } from './userFileHelper';
import { readEnv, writeEnv } from './envHelper';
import { WeiboScraper } from '../scraper/WeiboScraper';
import { closeDb } from '../storage/db';
import { Notifier } from './notifier';
import { AuthManager } from '../auth/AuthManager';
import { deletePostData } from '../storage/deleteUtility';
import * as fs from 'fs';

export class TelegramBot {
  private static running = false;
  private static isCrawling = false;
  private static isLoggingIn = false;

  /**
   * Start the Telegram polling listener loop
   */
  static async start(): Promise<void> {
    if (this.running) return;
    this.running = true;

    logger.info("Starting Telegram Bot listener daemon...");
    await Notifier.sendText("🤖 微博爬虫机器人已成功在交互式守护模式下运行。\n发送 /help 可以查看支持的指令列表。");

    this.startScheduler();

    let lastUpdateId = 0;

    while (this.running) {
      try {
        const token = config.TELEGRAM_BOT_TOKEN;
        if (!token) {
          logger.error("TELEGRAM_BOT_TOKEN is not configured. Stopping Telegram Bot.");
          this.running = false;
          break;
        }

        const apiBase = config.TELEGRAM_API_BASE || 'https://api.telegram.org';
        const url = `${apiBase}/bot${token}/getUpdates?offset=${lastUpdateId + 1}&timeout=30`;
        const response = await fetch(url, { signal: AbortSignal.timeout(45000) });

        if (response.ok) {
          const data = (await response.json()) as any;
          if (data.ok && data.result && data.result.length > 0) {
            for (const update of data.result) {
              lastUpdateId = update.update_id;
              await this.handleUpdate(update);
            }
          }
        } else {
          logger.error(`Telegram getUpdates failed with status ${response.status}: ${await response.text()}`);
        }
      } catch (err) {
        logger.error("Error in Telegram bot polling loop", err);
      }

      // Delay before next polling request to avoid spamming on error
      await new Promise(resolve => setTimeout(resolve, 2000));
    }
  }

  /**
   * Stop the Telegram polling listener loop
   */
  static stop(): void {
    this.running = false;
    logger.info("Telegram Bot listener daemon stopped.");
  }

  /**
   * Process incoming updates
   */
  private static async handleUpdate(update: any): Promise<void> {
    const message = update.message;
    if (!message || !message.text) return;

    const chatId = message.chat.id.toString();
    const text = message.text.trim();

    // Security Check: Verify Telegram Chat ID
    if (chatId !== config.TELEGRAM_CHAT_ID) {
      logger.warn(`Unauthorized command attempt from Chat ID: ${chatId}. Expected ID: ${config.TELEGRAM_CHAT_ID}`);
      try {
        const token = config.TELEGRAM_BOT_TOKEN;
        const apiBase = config.TELEGRAM_API_BASE || 'https://api.telegram.org';
        await fetch(`${apiBase}/bot${token}/sendMessage`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            chat_id: chatId,
            text: "❌ 未经授权的访问。此微博爬虫机器人是私有的，仅对其所有者响应。",
          }),
        });
      } catch (err) {
        logger.error("Failed to send unauthorized reply", err);
      }
      return;
    }

    const parts = text.split(/\s+/);
    const command = parts[0].toLowerCase();

    try {
      if (command === '/help') {
        await this.showHelp();
      } else if (command === '/status') {
        await this.showStatus();
      } else if (command === '/logout') {
        if (fs.existsSync(config.STATE_FILE)) {
          fs.unlinkSync(config.STATE_FILE);
          await Notifier.sendText("✅ 已成功退出登录。state.json 已被删除。");
        } else {
          await Notifier.sendText("ℹ️ 已经是退出登录状态。未找到 state.json 文件。");
        }
      } else if (command === '/login') {
        await this.handleLogin();
      } else if (command === '/run' || command === '/crawl') {
        await this.handleCrawlRun();
      } else if (command === '/crawl_post' || command === '/c') {
        await this.handleCrawlPost(parts);
      } else if (command === '/delete_post' || command === '/d') {
        await this.handleDeletePost(parts);
      } else if (command === '/user' || command === '/userid') {
        await this.handleUserCommand(parts);
      } else if (command === '/env') {
        await this.handleEnvCommand(parts);
      } else {
        await Notifier.sendText(`❓ 未知指令: ${command}。输入 /help 查看所有可用指令。`);
      }
    } catch (err: any) {
      logger.error(`Error processing command ${command}`, err);
      await Notifier.sendText(`❌ 处理指令失败: ${err.message || err}`);
    }
  }

  private static async showHelp(): Promise<void> {
    const helpMsg = `🤖 微博爬虫机器人指令手册 🤖

你可以通过发送以下指令与微博爬虫交互：

核心指令：
• /help - 显示此帮助菜单。
• /status - 查看当前的爬虫配置和运行状态。
• /login - 启动浏览器进行登录状态检查，若失效则接收登录二维码。
• /logout - 清除登录会话（删除 state.json）。
• /run 或 /crawl - 在后台启动主程序的增量爬取。

定向操作（绕过日期和游标限制）：
• \`/c\` <链接/BID/MID> 或 <日期> [UID] - 定向爬取单条微博或指定日期的数据。
• \`/d\` <链接/BID/MID> 或 <日期> [UID] - 定向物理删除单条微博或指定日期的备份数据（包括媒体文件、数据库记录、Markdown、CSV）。
  （注意：如果 userid.txt 中只配置启用了一个博主，[UID] 参数可以省略）。

博主列表（userid.txt）管理：
• /user list - 列出所有目标博主和增量游标。
• \`/user add\` <UID> <名称> - 在列表中新增博主 UID 及昵称。
• \`/user del\` <UID> - 从列表中删除指定博主。
• \`/user disable\` <UID> - 暂时禁用（注释掉）指定博主。
• \`/user enable\` <UID> - 重新启用指定博主。
• \`/user date\` <UID> <YYYY-MM-DD> - 为指定博主设置自定义的同步起点日期游标。

环境变量（.env）配置管理：
• /env list - 显示所有环境变量配置值。
• \`/env get\` <键名> - 获取特定变量的值.
• \`/env set\` <键名> <变量值> - 修改配置并立即生效。`;

    await Notifier.sendText(helpMsg, 'Markdown');
  }

  private static async showStatus(): Promise<void> {
    const stateExists = fs.existsSync(config.STATE_FILE);
    const sessionExpired = stateExists ? await AuthManager.isSessionExpired() : true;

    const statusMsg = `📊 微博爬虫当前运行状态：
• 登录状态：${stateExists ? (sessionExpired ? "❌ 登录已过期" : "✅ 已登录") : "❌ 未登录 (无 state.json)"}
• 爬取状态：${this.isCrawling ? "🔄 运行中" : "💤 空闲"}
• 守护模式：${config.DAEMON_MODE ? "🟢 已启用" : "🔴 已禁用"}
• 登录模式：${config.LOGIN_MODE}
• 无头模式：${config.HEADLESS ? "启用" : "禁用"}
• 开始日期：${config.START_DATE || "无限制（主页模式）"}
• 结束日期：${config.END_DATE || "无限制（今天）"}
• 日期排序：${config.DATE_ORDER}
• 输出目录：${config.OUTPUT_DIR}
• 存储格式：${config.SAVE_TYPES.join(', ')}
• 数据库类型：${config.DB_TYPE || "未配置"}`;

    await Notifier.sendText(statusMsg);
  }

  private static async handleLogin(): Promise<void> {
    if (this.isCrawling) {
      await Notifier.sendText("⚠️ 爬虫程序正在运行，请待其结束后再执行登录检查。");
      return;
    }
    if (this.isLoggingIn) {
      await Notifier.sendText("⚠️ 已经在进行登录检查或等待扫码中，请勿重复操作。");
      return;
    }

    this.isLoggingIn = true;
    await Notifier.sendText("🔍 正在检查登录状态... 若需要重新扫码，稍后将发送二维码图片。");

    // Run login check in background
    (async () => {
      try {
        const originalMode = config.LOGIN_MODE;
        // Temporarily force bot notify mode so QR code is sent to Telegram
        config.LOGIN_MODE = 'BOT_NOTIFY';

        await AuthManager.ensureLogin("✅ 扫码登录成功！当前会话已同步。");

        config.LOGIN_MODE = originalMode;
        await Notifier.sendText("✅ 登录检查完毕，已成功登录！");
      } catch (err: any) {
        logger.error("Login failed during bot command", err);
        await Notifier.sendText(`❌ 登录检查失败: ${err.message || err}`);
      } finally {
        this.isLoggingIn = false;
      }
    })();
  }

  private static async handleCrawlRun(): Promise<void> {
    if (this.isCrawling) {
      await Notifier.sendText("⚠️ 爬虫已经在后台运行中。");
      return;
    }
    if (this.isLoggingIn) {
      await Notifier.sendText("⚠️ 正在执行登录检查，请待其完成后再启动爬虫。");
      return;
    }

    this.isCrawling = true;
    await Notifier.sendText("🚀 已在后台启动微博爬取任务,请稍候...");

    // Run scraper in background
    (async () => {
      try {
        const scraper = new WeiboScraper();
        const summary = await scraper.run();
        await closeDb();
        await Notifier.sendText(summary);
      } catch (err: any) {
        logger.error("Crawl run failed via bot command", err);
        try {
          await closeDb();
        } catch { }
        await Notifier.sendText(`❌ 微博爬虫同步失败: ${err.message || err}`);
      } finally {
        this.isCrawling = false;
      }
    })();
  }

  private static async handleUserCommand(parts: string[]): Promise<void> {
    const sub = parts[1]?.toLowerCase();
    if (!sub || sub === 'list') {
      const users = readUsers();
      if (users.length === 0) {
        await Notifier.sendText("ℹ️ 博主列表文件（userid.txt）中未发现任何记录。");
      } else {
        let msg = "📋 博主列表及增量游标：\n";
        users.forEach((u, i) => {
          if (u.rawLine !== undefined) {
            if (u.rawLine.trim()) {
              msg += `${i + 1}. [注释/其他] ${u.rawLine}\n`;
            }
          } else {
            const status = u.isCommented ? '🔴 禁用' : '🟢 启用';
            msg += `${i + 1}. ${status} | \`${u.uid}\` | ${u.name || '无昵称'} | 游标: ${u.cursor || '无'}\n`;
          }
        });
        await Notifier.sendText(msg, 'Markdown');
      }
    } else if (sub === 'add') {
      const uid = parts[2];
      const name = parts.slice(3).join(' ') || '未命名';
      if (!uid || !/^\d+$/.test(uid)) {
        await Notifier.sendText("⚠️ 格式错误。正确格式：/user add <UID> <名称>");
      } else {
        addUser(uid, name);
        await Notifier.sendText(`✅ 成功添加博主 ${name} (${uid})`);
      }
    } else if (sub === 'del' || sub === 'delete' || sub === 'remove') {
      const uid = parts[2];
      if (!uid) {
        await Notifier.sendText("⚠️ 格式错误。正确格式：/user del <UID>");
      } else {
        const displayName = this.getBloggerDisplayName(uid);
        const ok = deleteUser(uid);
        if (ok) {
          await Notifier.sendText(`✅ 成功从列表中删除：${displayName}`);
        } else {
          await Notifier.sendText(`❌ 未找到 UID 为 ${uid} 的博主。`);
        }
      }
    } else if (sub === 'disable' || sub === 'comment') {
      const uid = parts[2];
      if (!uid) {
        await Notifier.sendText("⚠️ 格式错误。正确格式：/user disable <UID>");
      } else {
        const displayName = this.getBloggerDisplayName(uid);
        const ok = commentUser(uid, true);
        if (ok) {
          await Notifier.sendText(`✅ 已成功禁用：${displayName}`);
        } else {
          await Notifier.sendText(`❌ 未找到 UID 为 ${uid} 的博主。`);
        }
      }
    } else if (sub === 'enable' || sub === 'uncomment') {
      const uid = parts[2];
      if (!uid) {
        await Notifier.sendText("⚠️ 格式错误。正确格式：/user enable <UID>");
      } else {
        const displayName = this.getBloggerDisplayName(uid);
        const ok = commentUser(uid, false);
        if (ok) {
          await Notifier.sendText(`✅ 已成功启用：${displayName}`);
        } else {
          await Notifier.sendText(`❌ 未找到 UID 为 ${uid} 的博主。`);
        }
      }
    } else if (sub === 'date' || sub === 'setdate' || sub === 'cursor') {
      const uid = parts[2];
      const dateStr = parts[3];
      if (!uid || !dateStr) {
        await Notifier.sendText("⚠️ 格式错误。正确格式：/user date <UID> <YYYY-MM-DD[THH:mm:ss]>");
      } else {
        const displayName = this.getBloggerDisplayName(uid);
        const ok = setUserCursor(uid, dateStr);
        if (ok) {
          await Notifier.sendText(`✅ 已成功为 ${displayName} 设置同步起点游标为 ${dateStr}`);
        } else {
          await Notifier.sendText(`❌ 未找到 UID 为 ${uid} 的博主。`);
        }
      }
    } else {
      await Notifier.sendText("❓ 未知子命令。请使用 /user list, /user add, /user del, /user disable, /user enable, 或 /user date。");
    }
  }

  private static async handleEnvCommand(parts: string[]): Promise<void> {
    const sub = parts[1]?.toLowerCase();
    if (!sub || sub === 'list') {
      const env = readEnv();
      let msg = "⚙️ 环境变量当前配置：\n";
      for (const [key, val] of Object.entries(env)) {
        if (key === 'START_DATE') continue;
        const isSensitive = /token|chat_id|secret|password|uri/i.test(key);
        const displayVal = isSensitive ? "******" : val;
        if (displayVal === '') {
          msg += `\`${key}\` = \`""\`\n`;
        } else {
          msg += `\`${key}\` = \`${displayVal}\`\n`;
        }
      }
      await Notifier.sendText(msg, 'Markdown');
    } else if (sub === 'get') {
      const key = parts[2]?.toUpperCase();
      if (!key) {
        await Notifier.sendText("⚠️ 格式错误。正确格式：/env get <键名>");
      } else {
        const env = readEnv();
        const val = env[key] || env[`WEIBO_${key}`];
        if (val === undefined) {
          await Notifier.sendText(`❌ 未找到变量：${key}`);
        } else {
          const isSensitive = /token|chat_id|secret|password|uri/i.test(key);
          const displayVal = isSensitive ? "******" : val;
          if (displayVal === '') {
            await Notifier.sendText(`\`${key}\` = \`""\``, 'Markdown');
          } else {
            await Notifier.sendText(`\`${key}\` = \`${displayVal}\``, 'Markdown');
          }
        }
      }
    } else if (sub === 'set') {
      const key = parts[2]?.toUpperCase();
      const value = parts.slice(3).join(' ');
      if (!key || value === undefined) {
        await Notifier.sendText("⚠️ 格式错误。正确格式：/env set <键名> <配置值>");
      } else {
        writeEnv(key, value);
        const isSensitive = /token|chat_id|secret|password|uri/i.test(key);
        const displayVal = isSensitive ? "******" : value;
        if (displayVal === '') {
          await Notifier.sendText(`✅ 已成功修改并重新加载配置：\`${key}\` = \`""\``, 'Markdown');
        } else {
          await Notifier.sendText(`✅ 已成功修改并重新加载配置：\`${key}\` = \`${displayVal}\``, 'Markdown');
        }
      }
    } else {
      await Notifier.sendText("❓ 未知子命令。请使用 /env list, /env get <键名>, 或 /env set <键名> <配置值>。");
    }
  }

  private static async handleCrawlPost(parts: string[]): Promise<void> {
    const target = parts[1];
    if (!target) {
      await Notifier.sendText("⚠️ 格式错误。正确格式：/c <链接/BID/MID> 或 /c <日期> [UID]");
      return;
    }
    if (this.isCrawling) {
      await Notifier.sendText("⚠️ 爬虫正忙，请待当前任务结束后再试。");
      return;
    }
    if (this.isLoggingIn) {
      await Notifier.sendText("⚠️ 登录状态检查中，请稍候。");
      return;
    }

    const isDate = /^\d{4}-\d{2}-\d{2}$/.test(target);
    let resolvedUid = "";
    if (isDate) {
      try {
        const specUid = parts[2];
        const active = readUsers().filter(u => !u.isCommented && u.uid);
        if (specUid) {
          resolvedUid = specUid;
        } else if (active.length === 1) {
          resolvedUid = active[0].uid!;
        } else if (active.length === 0) {
          await Notifier.sendText("❌ 错误：在 userid.txt 中未找到启用的博主。");
          return;
        } else {
          await Notifier.sendText(`❌ 错误：配置了多个博主，请指定 UID：\`/c ${target} <UID>\``, 'Markdown');
          return;
        }
      } catch (err: any) {
        await Notifier.sendText(`❌ 解析博主失败: ${err.message}`);
        return;
      }
    }

    this.isCrawling = true;
    if (isDate) {
      await Notifier.sendText(`🚀 已在后台启动针对 ${this.getBloggerDisplayName(resolvedUid)} 在日期 ${target} 的定向爬取...`);
    } else {
      await Notifier.sendText(`🚀 已在后台启动针对微博 "${target}" 的单条定向爬取...`);
    }

    // Run in background
    (async () => {
      try {
        const scraper = new WeiboScraper();
        let res;
        if (isDate) {
          res = await scraper.crawlDateForUser(resolvedUid, target);
        } else {
          res = await scraper.crawlSinglePost(target);
        }

        if (res.success) {
          await Notifier.sendText(`✅ 定向爬取成功：\n${res.message}`);
        } else {
          await Notifier.sendText(`❌ 定向爬取失败：\n${res.message}`);
        }
      } catch (err: any) {
        logger.error(`Error in bot crawl command:`, err);
        await Notifier.sendText(`❌ 定向爬取过程中发生错误: ${err.message || err}`);
      } finally {
        this.isCrawling = false;
        try {
          await closeDb();
        } catch { }
      }
    })();
  }

  private static async handleDeletePost(parts: string[]): Promise<void> {
    const target = parts[1];
    if (!target) {
      await Notifier.sendText("⚠️ 格式错误。正确格式：/d <链接/BID/MID> 或 /d <日期> [UID]");
      return;
    }
    if (this.isCrawling) {
      await Notifier.sendText("⚠️ 爬虫正忙，为了防止冲突，请在任务结束后再进行删除。");
      return;
    }

    const isDate = /^\d{4}-\d{2}-\d{2}$/.test(target);
    let resolvedUid = "";
    if (isDate) {
      try {
        const specUid = parts[2];
        const active = readUsers().filter((u: any) => !u.isCommented && u.uid);
        if (specUid) {
          resolvedUid = specUid;
        } else if (active.length === 1) {
          resolvedUid = active[0].uid!;
        } else if (active.length === 0) {
          await Notifier.sendText("❌ 错误：在 userid.txt 中未找到启用的博主。");
          return;
        } else {
          await Notifier.sendText(`❌ 错误：配置了多个博主，请指定 UID：\`/d ${target} <UID>\``, 'Markdown');
          return;
        }
      } catch (err: any) {
        await Notifier.sendText(`❌ 解析博主失败: ${err.message}`);
        return;
      }
    }

    if (isDate) {
      await Notifier.sendText(`🗑️ 正在对 ${this.getBloggerDisplayName(resolvedUid)} 在日期 ${target} 触发定向物理清除...`);
    } else {
      await Notifier.sendText(`🗑️ 正在对微博 "${target}" 触发单条定向物理清除...`);
    }

    try {
      let res;
      if (isDate) {
        const { deleteDateData } = require('../storage/deleteUtility');
        res = await deleteDateData(resolvedUid, target);
      } else {
        res = await deletePostData(target);
      }

      if (res.success) {
        await Notifier.sendText(`✅ 定向物理删除成功：\n${res.message}`);
      } else {
        await Notifier.sendText(`❌ 定向物理删除失败：\n${res.message}`);
      }
    } catch (err: any) {
      logger.error(`Error in bot delete command:`, err);
      await Notifier.sendText(`❌ 定向物理删除发生错误: ${err.message || err}`);
    } finally {
      try {
        await closeDb();
      } catch { }
    }
  }

  /**
   * Starts a daily check for scheduled auto crawls based on config.SCHEDULE_CRAWL_TIME
   */
  private static startScheduler(): void {
    const scheduleTime = config.SCHEDULE_CRAWL_TIME;
    if (!scheduleTime) return;

    // Support comma-separated multiple times, e.g. "00:30,12:00,18:30"
    const times = scheduleTime.split(',').map(t => t.trim()).filter(Boolean);
    const parsedTimes: { hour: number; minute: number; raw: string }[] = [];

    for (const timeStr of times) {
      const parts = timeStr.split(':');
      const targetHour = parseInt(parts[0], 10);
      const targetMinute = parseInt(parts[1], 10);
      if (isNaN(targetHour) || isNaN(targetMinute)) {
        logger.error(`[Scheduler] 无法解析时间: "${timeStr}"。期望格式为 HH:MM。`);
        continue;
      }
      parsedTimes.push({ hour: targetHour, minute: targetMinute, raw: timeStr });
    }

    if (parsedTimes.length === 0) return;

    logger.info(`[Scheduler] 自动爬取定时器已启动。设定运行时间：北京时间 ${parsedTimes.map(pt => pt.raw).join(', ')}`);

    const runRegistry = new Set<string>();

    setInterval(async () => {
      try {
        const now = new Date();
        // 计算北京时间 (UTC+8)
        const utc = now.getTime() + (now.getTimezoneOffset() * 60000);
        const beijingTime = new Date(utc + (3600000 * 8));

        const hour = beijingTime.getHours();
        const minute = beijingTime.getMinutes();
        const year = beijingTime.getFullYear();
        const month = String(beijingTime.getMonth() + 1).padStart(2, '0');
        const day = String(beijingTime.getDate()).padStart(2, '0');
        const todayDateStr = `${year}-${month}-${day}`;

        // 每天清理历史 registry 键防止内存泄露
        for (const key of runRegistry) {
          if (!key.startsWith(`${todayDateStr}_`)) {
            runRegistry.delete(key);
          }
        }

        for (const pt of parsedTimes) {
          const registryKey = `${todayDateStr}_${pt.raw}`;

          if (hour === pt.hour && minute === pt.minute && !runRegistry.has(registryKey)) {
            runRegistry.add(registryKey);

            if (this.isCrawling) {
              logger.warn(`[Scheduler] 达到定时时间 ${pt.raw}，但爬虫目前正忙。跳过本次定时爬取。`);
              await Notifier.sendText(`⚠️ [定时任务跳过提示] 达到定时自动爬取时间 (${pt.raw})，但爬虫当前正在运行中，已跳过本次任务。`);
              continue;
            }

            if (this.isLoggingIn) {
              logger.warn(`[Scheduler] 达到定时时间 ${pt.raw}，但正在执行登录检查。跳过本次定时爬取。`);
              await Notifier.sendText(`⚠️ [定时任务跳过提示] 达到定时自动爬取时间 (${pt.raw})，但系统当前正处于登录状态检查中，已跳过本次任务。`);
              continue;
            }

            this.isCrawling = true;
            logger.info(`[Scheduler] 定时任务触发：开始进行自动增量爬取...`);
            await Notifier.sendText(`⏰ [定时任务触发] 达到北京时间 ${pt.raw}，开始执行自动增量同步...`);

            (async () => {
              try {
                const scraper = new WeiboScraper();
                const summary = await scraper.run();
                await closeDb();
                await Notifier.sendText(`⏰ [定时任务同步成功]\n\n${summary}`);
              } catch (err: any) {
                logger.error("[Scheduler] 定时任务爬取失败:", err);
                try {
                  await closeDb();
                } catch { }
                await Notifier.sendText(`❌ [定时任务同步失败]\n\n错误原因: ${err.message || err}`);
              } finally {
                this.isCrawling = false;
              }
            })();
          }
        }
      } catch (err: any) {
        logger.error("[Scheduler] 定时器轮询发生异常:", err);
      }
    }, 30000); // 每 30 秒检查一次
  }

  /**
   * Resolve nickname and format displayName: Nickname (UID) or just UID if not found
   */
  private static getBloggerDisplayName(uid: string): string {
    try {
      const users = readUsers();
      const match = users.find((u: any) => u.uid === uid);
      if (match?.name) {
        return `${match.name} (${uid})`;
      }
    } catch {}
    return uid;
  }
}
