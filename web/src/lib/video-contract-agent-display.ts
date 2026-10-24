import type { VideoContractAgentDetail } from "./api";

export const videoContractToolLabels: Record<string, string> = {
  inspect_protocols: "查询内置协议",
  read_documents: "读取相关文档",
  validate_contracts: "校验契约与请求",
  finish: "整理审核结果",
};

function jsonObject(value?: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(value || "");
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

export function videoContractToolSummary(entry: VideoContractAgentDetail): string {
  if (entry.summary) return entry.summary;
  if (entry.status === "failed") return entry.error ? "本次调用失败" : entry.output?.slice(0, 240) || "本次调用失败";
  const output = jsonObject(entry.output);
  const input = jsonObject(entry.input);
  switch (entry.name) {
    case "inspect_protocols": {
      if (entry.status === "running") return "读取可用驱动及其接口定义";
      try {
        const protocols: unknown = JSON.parse(entry.output || "");
        if (Array.isArray(protocols)) return `已读取 ${protocols.length} 种内置协议，供模型匹配`;
      } catch { /* Long tool output may be truncated by the server. */ }
      return "已读取内置协议目录";
    }
    case "read_documents": {
      const ids = Array.isArray(input?.ids) ? input.ids.filter(id => typeof id === "number") : [];
      if (entry.status === "running") return ids.length ? `正在读取 ${ids.length} 个相关页面` : "正在读取相关页面";
      return "读取已结束";
    }
    case "validate_contracts": {
      if (entry.status === "running") return "核对文档证据、参数约束与实际请求构造";
      if (Array.isArray(output?.review)) {
        const pending = output.review.filter(item => item && typeof item === "object" && "review_passed" in item && !item.review_passed).length;
        return `已校验 ${output.review.length} 份契约${pending ? `，其中 ${pending} 份有待确认项` : ""}`;
      }
      return "契约与请求校验已完成";
    }
    case "finish":
      return entry.status === "running" ? "汇总已校验的契约草稿" : typeof output?.contracts === "number" ? `已整理 ${output.contracts} 份契约草稿，等待审核` : "契约草稿已整理，等待审核";
    default:
      return entry.status === "running" ? "正在执行工具" : "工具执行已完成";
  }
}
