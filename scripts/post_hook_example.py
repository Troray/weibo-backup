#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Weibo-Backup 后置扩展脚本标准示例 (Python)
演示如何读取爬虫环境变量、执行网盘备份操作，并向爬虫回传结构化结果。
"""

import os
import sys
import json

def main():
    # 1. 从环境变量读取爬虫上下文
    task_status = os.getenv("WEIBO_TASK_STATUS", "UNKNOWN")
    posts_count = int(os.getenv("WEIBO_POSTS_COUNT", "0"))
    media_count = int(os.getenv("WEIBO_MEDIA_COUNT", "0"))
    output_dir = os.getenv("WEIBO_OUTPUT_DIR", "./output")
    result_file = os.getenv("WEIBO_HOOK_RESULT_FILE")

    print(f"[Hook Script] 接收到爬虫任务结束信号: 状态={task_status}, 新增微博={posts_count}, 媒体={media_count}")
    print(f"[Hook Script] 本地归档目录: {output_dir}")

    # 2. 执行自定义备份逻辑 (例如调用 rclone、Alist API、阿里云盘 CLI、WebDAV 同步等)
    # 此处为示例逻辑：
    upload_success = True
    error_msg = ""
    summary_text = f"成功同步本地备份至云盘 (微博 {posts_count} 条, 媒体 {media_count} 项)"

    # 3. 按照标准协议回写结构化结果给爬虫
    if result_file:
        try:
            result_payload = {
                "success": upload_success,
                "summary": summary_text,
                "uploaded_count": media_count,
                "remote_target": "CloudDrive:/WeiboBackup",
                "error": error_msg
            }
            with open(result_file, "w", encoding="utf-8") as f:
                json.dump(result_payload, f, ensure_ascii=False, indent=2)
            print(f"[Hook Script] 已成功写入结构化回调结果至: {result_file}")
        except Exception as e:
            print(f"[Hook Script] 写入结果文件失败: {e}")
    else:
        # 兜底方式: 打印前缀标签
        print(f"[WEIBO_HOOK_SUMMARY] {summary_text}")

    sys.exit(0 if upload_success else 1)

if __name__ == "__main__":
    main()
