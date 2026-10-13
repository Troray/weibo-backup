import { spawn, ChildProcess } from 'child_process';
import * as path from 'path';
import * as fs from 'fs';
import { config } from '../config';
import { logger } from './logger';
import { escapeHtml } from './htmlHelper';

export interface HookContext {
  status: 'SUCCESS' | 'FAILED' | 'SESSION_EXPIRED';
  taskType: 'INCREMENTAL' | 'TARGETED_DATE' | 'TARGETED_POST';
  triggerSource: 'CLI' | 'TG_BOT' | 'SCHEDULE';
  postsCount: number;
  mediaCount: number;
  commentsCount: number;
  targetUsers: string[];
  durationSec: number;
  summaryText?: string;
}

export interface HookExecutionResult {
  executed: boolean;
  skippedReason?: string;
  isAsync?: boolean;
  success: boolean;
  durationMs: number;
  exitCode: number | null;
  summary: string;
  detail?: string;
  error?: string;
  rawOutput?: string;
}

interface HookResultFilePayload {
  success?: boolean;
  summary?: string;
  uploaded_count?: number;
  remote_target?: string;
  detail?: string;
  error?: string;
}

let activeChildProcess: ChildProcess | null = null;
let isHookRunning = false;

/**
 * 递归杀灭子进程树（跨平台支持）
 */
function killProcessTree(child: ChildProcess): void {
  if (!child || !child.pid) return;
  const pid = child.pid;
  try {
    if (process.platform === 'win32') {
      spawn('taskkill', ['/pid', String(pid), '/T', '/F'], {
        windowsHide: true,
        stdio: 'ignore'
      });
    } else {
      try {
        process.kill(-pid, 'SIGKILL');
      } catch {
        child.kill('SIGKILL');
      }
    }
  } catch (err) {
    logger.debug(`Failed to kill process tree for PID ${pid}:`, err);
  }
}

/**
 * 注册主进程退出时的子进程级联清理
 */
export function cleanupActiveHookProcess(): void {
  if (activeChildProcess) {
    logger.warn(`主程序退出中，正在安全终止当前活跃的后置扩展脚本 (PID: ${activeChildProcess.pid})...`);
    killProcessTree(activeChildProcess);
    activeChildProcess = null;
  }
}

/**
 * 追加写入后置脚本执行日志，并执行单文件 10MB 自动轮转 (保留最近 3 份历史副本)
 */
function appendHookLog(logsDir: string, entry: string): void {
  try {
    if (!fs.existsSync(logsDir)) {
      fs.mkdirSync(logsDir, { recursive: true });
    }
    const logPath = path.join(logsDir, 'post-hook.log');
    if (fs.existsSync(logPath)) {
      try {
        const stats = fs.statSync(logPath);
        if (stats.size >= 10 * 1024 * 1024) {
          const maxFiles = 3;
          for (let i = maxFiles - 1; i >= 1; i--) {
            const current = path.join(logsDir, `post-hook.${i}.log`);
            const next = path.join(logsDir, `post-hook.${i + 1}.log`);
            if (fs.existsSync(current)) {
              if (i === maxFiles - 1) {
                try { fs.unlinkSync(current); } catch {}
              } else {
                try { fs.renameSync(current, next); } catch {}
              }
            }
          }
          const firstBackup = path.join(logsDir, 'post-hook.1.log');
          try { fs.renameSync(logPath, firstBackup); } catch {}
        }
      } catch {}
    }
    fs.appendFileSync(logPath, entry, 'utf8');
  } catch {}
}

/**
 * 智能解析外部脚本命令与解释器
 */
function resolveScriptCommand(rawCmd: string): string {
  const trimmed = rawCmd.trim();
  if (!trimmed) return '';

  // 若用户直接输入了 .py 脚本路径
  if (/^[^\s"']+\.py$/i.test(trimmed)) {
    const isWindows = process.platform === 'win32';
    const pyExe = isWindows ? 'python' : 'python3';
    return `${pyExe} "${trimmed}"`;
  }

  // 若用户直接输入了 .sh 脚本路径
  if (/^[^\s"']+\.sh$/i.test(trimmed)) {
    return `bash "${trimmed}"`;
  }

  // 若用户直接输入了 .ps1 脚本路径
  if (/^[^\s"']+\.ps1$/i.test(trimmed)) {
    return `powershell.exe -ExecutionPolicy Bypass -File "${trimmed}"`;
  }

  // 若用户直接输入了 .bat / .cmd 脚本路径
  if (/^[^\s"']+\.(bat|cmd)$/i.test(trimmed)) {
    return `cmd.exe /c "${trimmed}"`;
  }

  return trimmed;
}

/**
 * 格式化 rclone 耗时时间戳（如 11m51.2s -> 11分51秒）
 */
function formatRcloneDuration(raw: string): string {
  const hMatch = raw.match(/(\d+)h/i);
  const mMatch = raw.match(/(\d+)m/i);
  const sMatch = raw.match(/([0-9.]+)s/i);
  const msMatch = raw.match(/([0-9.]+)ms/i);

  const parts: string[] = [];
  if (hMatch) parts.push(`${hMatch[1]}小时`);
  if (mMatch) parts.push(`${mMatch[1]}分`);
  if (sMatch) parts.push(`${Math.round(parseFloat(sMatch[1]))}秒`);
  else if (msMatch) parts.push(`${Math.round(parseFloat(msMatch[1]))}毫秒`);

  return parts.length > 0 ? parts.join('') : raw;
}

/**
 * 从 rclone 命令行中提取远程目标路径 (Remote Destination)
 */
function extractRcloneTarget(cmd: string): string | null {
  if (!cmd || !/\brclone\b/i.test(cmd)) return null;
  const match = cmd.match(/\brclone\s+(?:copy|sync|move|copyto|moveto)\s+(.+)$/i);
  if (!match) return null;
  const rest = match[1];
  const tokens: string[] = [];
  const regex = /"([^"]+)"|'([^']+)'|(\S+)/g;
  let m: RegExpExecArray | null;
  while ((m = regex.exec(rest)) !== null) {
    const token = m[1] || m[2] || m[3];
    if (!token.startsWith('-')) {
      tokens.push(token);
    }
  }
  if (tokens.length >= 2) {
    return tokens[1];
  }
  return null;
}

/**
 * 智能解析 rclone 输出统计信息并转换为友好中文摘要
 */
function parseRcloneOutput(output: string): string | null {
  if (!output) return null;

  const hasTransferred = /Transferred:\s+/i.test(output);
  const hasElapsed = /Elapsed time:\s+/i.test(output);
  const hasChecks = /Checks:\s+/i.test(output);

  if (!hasTransferred && !hasElapsed && !hasChecks) {
    return null;
  }

  // 1. 提取文件传输数量与进度: Transferred: 751 / 751, 100%
  const filesMatch = output.match(/Transferred:\s+(\d+)\s*\/\s*(\d+)(?:,\s*([0-9]+%|-))?/i);
  // 2. 提取数据体积: Transferred: 1.234 GiB / 1.234 GiB, 100%, 2.500 MiB/s
  const sizeMatch = output.match(/Transferred:\s+([0-9.]+\s*[KMGTPE]?i?B)\s*\/\s*([0-9.]+\s*[KMGTPE]?i?B)(?:,\s*([0-9]+%))?/i);
  // 3. 提取校验/索引清单: Checks: 0 / 0, -, Listed 782
  const checksMatch = output.match(/Checks:\s+(\d+)\s*\/\s*(\d+)(?:,\s*([0-9]+%|-))?(?:,\s*Listed\s*(\d+))?/i);
  // 4. 提取耗时: Elapsed time: 11m51.2s
  const elapsedMatch = output.match(/Elapsed time:\s*([0-9a-z.]+)/i);
  // 5. 提取错误与删除数
  const errorsMatch = output.match(/Errors:\s*(\d+)/i);
  const deletedMatch = output.match(/Deleted:\s*(\d+)/i);

  const parts: string[] = [];

  const errors = errorsMatch ? parseInt(errorsMatch[1], 10) : 0;
  if (errors > 0) {
    parts.push(`含 ${errors} 个传输错误`);
  }

  if (filesMatch) {
    const curFiles = filesMatch[1];
    const totalFiles = filesMatch[2];
    const percent = filesMatch[3] && filesMatch[3] !== '-' ? filesMatch[3] : '';

    if (totalFiles === '0') {
      parts.push('无需同步新文件 (0/0)');
    } else {
      let fileStr = `已传输 ${curFiles} / ${totalFiles} 个文件`;
      if (sizeMatch && sizeMatch[2]) {
        fileStr += ` (共 ${sizeMatch[2]}${percent ? ', ' + percent : ''})`;
      } else if (percent) {
        fileStr += ` (${percent})`;
      }
      parts.push(fileStr);
    }
  } else if (sizeMatch) {
    parts.push(`已传输 ${sizeMatch[1]} / ${sizeMatch[2]}${sizeMatch[3] ? ' (' + sizeMatch[3] + ')' : ''}`);
  }

  if (checksMatch) {
    const checked = checksMatch[1];
    const totalChecks = checksMatch[2];
    const listed = checksMatch[4];
    if (listed && listed !== '0') {
      parts.push(`索引清单: ${listed} 项`);
    } else if (totalChecks !== '0') {
      parts.push(`校验文件: ${checked} / ${totalChecks}`);
    }
  }

  if (deletedMatch && parseInt(deletedMatch[1], 10) > 0) {
    parts.push(`删除文件: ${deletedMatch[1]} 项`);
  }

  if (elapsedMatch) {
    parts.push(`耗时: ${formatRcloneDuration(elapsedMatch[1])}`);
  }

  return parts.length > 0 ? parts.join(' | ') : null;
}

/**
 * 检查当前任务上下文是否满足后置脚本的触发策略
 */
export function shouldExecuteHook(context: HookContext): { shouldRun: boolean; reason?: string } {
  const command = config.POST_SCRIPT_COMMAND?.trim();
  if (!command) {
    return { shouldRun: false, reason: '未配置 POST_SCRIPT_COMMAND' };
  }

  const trigger = config.POST_SCRIPT_TRIGGER || 'has_new_data';
  const isSuccess = context.status === 'SUCCESS';
  const hasNewData = context.postsCount > 0 || context.mediaCount > 0;

  switch (trigger) {
    case 'has_new_data':
      if (!isSuccess) {
        return { shouldRun: false, reason: `任务状态为 ${context.status} (非成功)，策略 has_new_data 跳过执行` };
      }
      if (!hasNewData) {
        return { shouldRun: false, reason: '本次任务未新增博文或媒体，策略 has_new_data 跳过执行' };
      }
      return { shouldRun: true };

    case 'success':
      if (!isSuccess) {
        return { shouldRun: false, reason: `任务状态为 ${context.status} (非成功)，策略 success 跳过执行` };
      }
      return { shouldRun: true };

    case 'failure':
      if (isSuccess) {
        return { shouldRun: false, reason: '任务状态为成功，策略 failure 跳过执行' };
      }
      return { shouldRun: true };

    case 'always':
      return { shouldRun: true };

    default:
      return { shouldRun: true };
  }
}

/**
 * 执行后置扩展脚本（核心调度器）
 */
export async function executePostScript(context: HookContext): Promise<HookExecutionResult> {
  const check = shouldExecuteHook(context);
  if (!check.shouldRun) {
    return {
      executed: false,
      skippedReason: check.reason,
      success: true,
      durationMs: 0,
      exitCode: 0,
      summary: ''
    };
  }

  if (isHookRunning) {
    logger.warn('[PostScript] 上一个后置脚本仍在运行中，为避免并发冲突跳过本次执行。');
    return {
      executed: false,
      skippedReason: '上一个脚本仍在运行中 (并发互斥保护)',
      success: false,
      durationMs: 0,
      exitCode: null,
      summary: '并发互斥跳过'
    };
  }

  const rawCmd = config.POST_SCRIPT_COMMAND!.trim();
  const fullCommand = resolveScriptCommand(rawCmd);
  const isWait = config.POST_SCRIPT_WAIT;
  const timeoutMs = config.POST_SCRIPT_TIMEOUT || 10 * 60 * 1000;
  const projectRoot = process.cwd();

  // 确保 scratch 缓存目录存在
  const scratchDir = path.join(projectRoot, 'scratch');
  try {
    if (!fs.existsSync(scratchDir)) {
      fs.mkdirSync(scratchDir, { recursive: true });
    }
  } catch {}

  const resultFilePath = path.join(scratchDir, `weibo_hook_res_${Date.now()}_${process.pid}.json`);

  // 装配子进程环境变量
  const childEnv: Record<string, string | undefined> = {
    ...process.env,
    WEIBO_TASK_STATUS: context.status,
    WEIBO_TASK_TYPE: context.taskType,
    WEIBO_TRIGGER_SOURCE: context.triggerSource,
    WEIBO_PROJECT_ROOT: projectRoot,
    WEIBO_OUTPUT_DIR: config.OUTPUT_DIR,
    WEIBO_POSTS_COUNT: String(context.postsCount || 0),
    WEIBO_MEDIA_COUNT: String(context.mediaCount || 0),
    WEIBO_COMMENTS_COUNT: String(context.commentsCount || 0),
    WEIBO_TARGET_USERS: context.targetUsers.join(','),
    WEIBO_DURATION_SEC: String(context.durationSec || 0),
    WEIBO_HOOK_RESULT_FILE: resultFilePath,
    // 强制 UTF-8 输出，防止 Windows 代码页 936 (GBK) 产生乱码
    PYTHONIOENCODING: 'utf-8',
    PYTHONUTF8: '1',
    LANG: 'zh_CN.UTF-8',
    LC_ALL: 'zh_CN.UTF-8'
  };

  // 网络代理隔离：默认不继承爬虫的代理，防止国内网盘/局域网 NAS 连接超时
  if (!config.POST_SCRIPT_INHERIT_PROXY) {
    delete childEnv.HTTP_PROXY;
    delete childEnv.HTTPS_PROXY;
    delete childEnv.ALL_PROXY;
    delete childEnv.http_proxy;
    delete childEnv.https_proxy;
    delete childEnv.all_proxy;
  }

  logger.info(`[PostScript] 正在触发后置扩展脚本 (触发策略: ${config.POST_SCRIPT_TRIGGER}, 模式: ${isWait ? '同步等待' : '后台分离'})`);
  logger.info(`[PostScript] 执行命令行: ${fullCommand}`);

  const startTime = Date.now();
  isHookRunning = true;

  try {
    if (!isWait) {
      // 模式 B：后台分离模式 (detached)
      const child = spawn(fullCommand, {
        cwd: projectRoot,
        env: childEnv as NodeJS.ProcessEnv,
        shell: true,
        detached: true,
        stdio: 'ignore'
      });
      child.unref();

      return {
        executed: true,
        isAsync: true,
        success: true,
        durationMs: 0,
        exitCode: 0,
        summary: `已在后台启动异步执行 (PID: ${child.pid})`
      };
    }

    // 模式 A：同步等待模式 (受超时熔断保护，显式关闭 stdin 防止交互死锁)
    const result = await new Promise<HookExecutionResult>((resolve) => {
      let child: ChildProcess;
      try {
        child = spawn(fullCommand, {
          cwd: projectRoot,
          env: childEnv as NodeJS.ProcessEnv,
          shell: true,
          stdio: ['ignore', 'pipe', 'pipe'] // stdin 明确置为 ignore，防止因等待敲回车而永久卡死
        });
      } catch (err: any) {
        resolve({
          executed: true,
          success: false,
          durationMs: Date.now() - startTime,
          exitCode: 1,
          summary: `启动外部脚本失败: ${err.message}`,
          error: err.message
        });
        return;
      }

      activeChildProcess = child;

      const stdoutChunks: Buffer[] = [];
      const stderrChunks: Buffer[] = [];

      child.stdout?.on('data', (chunk) => {
        stdoutChunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      });

      child.stderr?.on('data', (chunk) => {
        stderrChunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      });

      let isTimedOut = false;
      let forceKillTimer: NodeJS.Timeout | null = null;

      // 阶段一超时定时器
      const timeoutTimer = setTimeout(() => {
        isTimedOut = true;
        logger.error(`[PostScript] 外部脚本执行超过设定阈值 (${timeoutMs / 1000}s)，开始执行优雅终止 (SIGTERM)...`);
        
        try {
          child.kill('SIGTERM');
        } catch {}

        // 阶段二强杀定时器（等待 5s 优雅退出期）
        forceKillTimer = setTimeout(() => {
          logger.error(`[PostScript] 外部脚本在收到 SIGTERM 后未在 5s 内退出，强制杀灭进程树...`);
          killProcessTree(child);
          try {
            child.stdout?.destroy();
            child.stderr?.destroy();
          } catch {}
        }, 5000);
      }, timeoutMs);

      child.on('close', (code) => {
        clearTimeout(timeoutTimer);
        if (forceKillTimer) clearTimeout(forceKillTimer);
        activeChildProcess = null;

        const durationMs = Date.now() - startTime;
        const stdoutStr = Buffer.concat(stdoutChunks).toString('utf8');
        const stderrStr = Buffer.concat(stderrChunks).toString('utf8');
        const rawOutput = (stdoutStr + (stderrStr ? `\n[STDERR]\n${stderrStr}` : '')).trim();

        // 写入审计日志文件（带 10MB 自动滚动轮转）
        try {
          const logsDir = path.join(projectRoot, 'logs');
          const logEntry = `\n[${new Date().toISOString()}] CMD: ${fullCommand} | CODE: ${code} | DURATION: ${durationMs}ms\n${rawOutput}\n--------------------`;
          appendHookLog(logsDir, logEntry);
        } catch {}

        if (isTimedOut) {
          resolve({
            executed: true,
            success: false,
            durationMs,
            exitCode: code,
            summary: `执行超时 (已触发熔断终止，耗时 ${Math.round(durationMs / 1000)} 秒)`,
            error: 'TIMED_OUT',
            rawOutput
          });
          return;
        }

        // 1. 优先读取结果文件协议 (Result File Protocol)
        let fileResult: HookResultFilePayload | null = null;
        if (fs.existsSync(resultFilePath)) {
          try {
            const content = fs.readFileSync(resultFilePath, 'utf8');
            fileResult = JSON.parse(content);
          } catch (err) {
            logger.debug('[PostScript] 解析脚本回调结果 JSON 文件失败:', err);
          }
        }

        if (fileResult) {
          const isSuccess = fileResult.success !== undefined ? fileResult.success : (code === 0);
          resolve({
            executed: true,
            success: isSuccess,
            durationMs,
            exitCode: code,
            summary: fileResult.summary || (isSuccess ? '执行成功' : '执行失败'),
            detail: fileResult.detail || fileResult.remote_target,
            error: fileResult.error,
            rawOutput
          });
          return;
        }

        // 2. 检测标准输出前缀标签 (Stdout Tag: [WEIBO_HOOK_SUMMARY])
        const summaryMatch = stdoutStr.match(/\[WEIBO_HOOK_SUMMARY\]\s*([^\r\n]+)/);
        if (summaryMatch) {
          const summaryText = summaryMatch[1].trim();
          resolve({
            executed: true,
            success: code === 0,
            durationMs,
            exitCode: code,
            summary: summaryText,
            rawOutput
          });
          return;
        }

        // 2.5. 智能识别并美化 rclone 统计数据 (友好中文摘要与目标路径解析)
        const rcloneSummary = parseRcloneOutput(rawOutput);
        if (rcloneSummary) {
          const rcloneTarget = extractRcloneTarget(fullCommand);
          const hasRcloneErrors = /Errors:\s*[1-9]\d*/i.test(rawOutput);
          const isSuccess = code === 0 && !hasRcloneErrors;

          let rcloneErr: string | undefined = undefined;
          if (!isSuccess) {
            const errMatch = rawOutput.match(/ERROR\s*:\s*([^\r\n]+)/i);
            rcloneErr = errMatch ? errMatch[1].trim() : (stderrStr.slice(0, 200) || undefined);
          }

          resolve({
            executed: true,
            success: isSuccess,
            durationMs,
            exitCode: code,
            summary: rcloneSummary,
            detail: rcloneTarget || undefined,
            error: rcloneErr,
            rawOutput
          });
          return;
        }

        // 3. 兜底策略：提取 stdout/stderr 尾部有效行（压缩大段冗余空格并截断至安全长度防 Telegram 4096 溢出）
        const lines = (stdoutStr || stderrStr)
          .split(/\r?\n/)
          .map(l => l.trim().replace(/\s{2,}/g, ' '))
          .filter(Boolean);
        
        let fallbackSummary = '';
        if (lines.length > 0) {
          const lastLines = lines.slice(-3).join(' | ');
          fallbackSummary = lastLines.length > 200 ? `${lastLines.slice(0, 200)}...` : lastLines;
        } else {
          fallbackSummary = code === 0 ? '脚本执行成功 (无输出)' : `脚本异常退出 (退出码 ${code})`;
        }

        resolve({
          executed: true,
          success: code === 0,
          durationMs,
          exitCode: code,
          summary: fallbackSummary,
          error: code === 0 ? undefined : (stderrStr.slice(0, 200) || undefined),
          rawOutput
        });
      });

      child.on('error', (err) => {
        clearTimeout(timeoutTimer);
        if (forceKillTimer) clearTimeout(forceKillTimer);
        activeChildProcess = null;

        resolve({
          executed: true,
          success: false,
          durationMs: Date.now() - startTime,
          exitCode: 1,
          summary: `子进程发生异常: ${err.message}`,
          error: err.message
        });
      });
    });

    return result;
  } finally {
    isHookRunning = false;
    activeChildProcess = null;

    // 强一致清理：物理删除临时结果 JSON 文件，确保零残留
    if (fs.existsSync(resultFilePath)) {
      try {
        fs.unlinkSync(resultFilePath);
      } catch {}
    }
  }
}

/**
 * 格式化后置脚本执行状态，供合并追加至最终任务报告
 */
export function formatHookSummaryForReport(result: HookExecutionResult): string {
  if (!result.executed) {
    return '';
  }

  const scriptName = path.basename(config.POST_SCRIPT_COMMAND || '外部扩展脚本');
  let text = `\n<blockquote expandable>\n⚙️ <b>【后置扩展脚本运行结果】</b>\n`;

  if (result.isAsync) {
    text += `🔄 状态: 已在后台异步拉起执行 (脚本: ${escapeHtml(scriptName)})\n`;
    text += `💡 提示: 外部脚本正在后台独立运行，请稍后检查网盘或本地日志。\n</blockquote>\n`;
    return text;
  }

  const durationSec = Math.round(result.durationMs / 1000);
  if (result.success) {
    text += `✅ 状态: 执行成功 (耗时: ${durationSec} 秒 | 退出码: ${result.exitCode ?? 0})\n`;
    if (result.summary) {
      text += `📄 摘要: ${escapeHtml(result.summary)}\n`;
    }
    if (result.detail) {
      text += `🎯 目标: ${escapeHtml(result.detail)}\n`;
    }
  } else {
    text += `⚠️ 状态: 执行异常 (耗时: ${durationSec} 秒 | 退出码: ${result.exitCode ?? '未知'})\n`;
    if (result.summary) {
      text += `📄 提示: ${escapeHtml(result.summary)}\n`;
    }
    if (result.error) {
      text += `❌ 错误: ${escapeHtml(result.error)}\n`;
    }
  }
  text += `</blockquote>\n`;

  return text;
}
