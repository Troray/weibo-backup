#!/bin/bash
# ==========================================
# Weibo-Backup 后置扩展脚本示例 (Shell + rclone)
# ==========================================

echo "[Hook Script] 启动网盘同步任务..."
echo "[Hook Script] 目标目录: $WEIBO_OUTPUT_DIR, 新增博文: $WEIBO_POSTS_COUNT, 新增媒体: $WEIBO_MEDIA_COUNT"

# 执行 rclone 同步至网盘示例（取消注释使用）:
# rclone sync "$WEIBO_OUTPUT_DIR" "onedrive:/weibo-backup" --fast-list

EXIT_CODE=$?

if [ $EXIT_CODE -eq 0 ]; then
  # 通过前缀标签回传摘要给 Telegram / CLI 通知
  echo "[WEIBO_HOOK_SUMMARY] 成功同步至网盘 onedrive:/weibo-backup (新增博文: $WEIBO_POSTS_COUNT 篇, 媒体: $WEIBO_MEDIA_COUNT 项)"
  exit 0
else
  echo "[WEIBO_HOOK_SUMMARY] 网盘同步执行异常 (退出码: $EXIT_CODE)"
  exit $EXIT_CODE
fi
