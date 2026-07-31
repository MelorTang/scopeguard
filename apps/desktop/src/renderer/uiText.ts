const RUN_STATUS_LABELS: Record<string, string> = {
  queued: "排队中",
  preparing: "准备中",
  running: "运行中",
  "waiting-approval": "等待审批",
  cancelling: "正在停止",
  completed: "已完成",
  failed: "失败",
  cancelled: "已取消",
  interrupted: "已中断",
  draft: "草稿",
  ready: "待开始",
  "waiting-input": "等待输入",
  blocked: "已阻塞",
  archived: "已归档",
};

const TOOL_NAME_LABELS: Record<string, string> = {
  read_file: "读取文件",
  write_file: "写入文件",
  run_command: "运行命令",
  request_user_input: "请求补充信息",
};

export function formatRunStatus(value: string): string {
  return RUN_STATUS_LABELS[value] ?? value;
}

export function formatToolName(value: string): string {
  return TOOL_NAME_LABELS[value] ?? value.replaceAll("_", " ");
}
