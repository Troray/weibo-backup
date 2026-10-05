import { config } from '../config';
import { logger } from '../utils/logger';
import { sessionManager, SessionManager } from './SessionManager';
import { QRLogin } from './QRLogin';
import { SessionExpiredError } from './types';

export class AuthManager {
  /**
   * Main entry point to ensure session is authenticated.
   * If session is valid, it refreshes rolling session and continues.
   * Otherwise, it triggers the QR login flow.
   */
  public static async ensureLogin(onSuccessNotify?: string): Promise<void> {
    logger.info('[Auth] 正在检查微博登录认证会话状态...');

    sessionManager.load();

    const hasLocalAuth = sessionManager.isAuthenticated();

    if (hasLocalAuth) {
      logger.info(`[Auth] 发现本地持久化凭证，开始验证服务端有效性...`);
      const isValid = await sessionManager.validate();

      if (isValid) {
        logger.info('[Auth] 会话验证有效，正在进行主动心跳续期...');
        await sessionManager.refresh();
        logger.info('[Auth] 登录态就绪，继续执行后续任务。');
        return;
      }

      logger.warn('[Auth] 本地会话已过期或已被服务器注销，需要重新鉴权。');

      if (config.LOGIN_MODE === 'LOCAL_SYNC') {
        const errMsg = `会话文件 ${config.STATE_FILE} 中的登录态已失效，且 LOGIN_MODE 设置为 LOCAL_SYNC。请手动更新 state.json。`;
        logger.error(`[Auth] ${errMsg}`);
        throw new SessionExpiredError(errMsg);
      }
    } else {
      logger.info('[Auth] 未检测到可用的本地会话凭证。');
      if (config.LOGIN_MODE === 'LOCAL_SYNC') {
        const errMsg = `未找到状态文件 ${config.STATE_FILE} 或文件中无有效凭据，且 LOGIN_MODE 设置为 LOCAL_SYNC。请放置有效的 state.json 文件。`;
        logger.error(`[Auth] ${errMsg}`);
        throw new SessionExpiredError(errMsg);
      }
    }

    if (config.LOGIN_MODE === 'TERMINAL_QR' && !process.stdout.isTTY) {
      const errMsg = `[环境熔断] 当前配置为 TERMINAL_QR 模式，但检测到运行环境为非交互式终端（如 PM2 / systemd / Docker 后台）。用户无法看到控制台二维码，为防止无效的扫码等待与潜在的 IP 风控，已自动拦截并报错停止。请修改 LOGIN_MODE 配置（使用 LOCAL_SYNC 或 BOT_NOTIFY）或在交互式终端中重新运行以生成授权信息。`;
      logger.error(errMsg);
      throw new Error(errMsg);
    }

    logger.info(`[Auth] 启动交互式扫码登录流程 (模式: ${config.LOGIN_MODE})...`);
    const cookies = await QRLogin.login(onSuccessNotify);
    sessionManager.setCookies(cookies);

    // Refresh right after login to fetch user profile metadata and activate rolling window
    try {
      await sessionManager.refresh();
    } catch {}

    logger.info(`[Auth] 会话鉴权成功！状态已保存至 ${config.STATE_FILE}`);
  }

  /**
   * Helper to verify if the saved state is expired or invalid.
   * Backward compatible with existing callers like telegramBot.
   */
  public static async isSessionExpired(): Promise<boolean> {
    sessionManager.load();
    const isValid = await sessionManager.validate();
    return !isValid;
  }

  /**
   * Explicitly log out and clear persisted session.
   */
  public static logout(): void {
    sessionManager.clear();
  }
}
