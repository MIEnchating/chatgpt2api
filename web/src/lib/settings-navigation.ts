import { Archive, Bell, Clapperboard, Database, HardDrive, ImageIcon, KeyRound, ListChecks, Palette, ScrollText, Settings2, Sparkles, UserCircle2, type LucideIcon } from "lucide-react";
import { canAccessPath, type StoredAuthSession } from "@/lib/auth-session";

export type SettingsNavigationItem = {
  id: string;
  label: string;
  icon: LucideIcon;
  group: string;
  href: string;
  keywords: string;
  adminOnly?: boolean;
};

export const personalSettingsSections: SettingsNavigationItem[] = [
  { id: "account", label: "账户信息", icon: UserCircle2, group: "个人设置", href: "/profile#account", keywords: "账户 余额 额度 登录来源" },
  { id: "appearance", label: "外观", icon: Palette, group: "个人设置", href: "/profile#appearance", keywords: "主题 浅色 深色 界面" },
  { id: "keys", label: "API 密钥", icon: KeyRound, group: "个人设置", href: "/profile#keys", keywords: "Key API 自定义 接口" },
  { id: "creation", label: "创作偏好", icon: Settings2, group: "个人设置", href: "/profile#creation", keywords: "默认 模型 生成 图片 视频 音频" },
  { id: "storage", label: "素材存储", icon: HardDrive, group: "个人设置", href: "/profile#storage", keywords: "S3 R2 WebDAV 个人 外部存储" },
];

const systemSettingsSections: SettingsNavigationItem[] = [
  { id: "config", label: "站点与运行", icon: Settings2, group: "系统管理", href: "/settings#config", keywords: "网站 品牌 数据库 网络 代理 限制" },
  { id: "model-config", label: "模型服务", icon: Sparkles, group: "系统管理", href: "/settings#model-config", keywords: "全局 模型 渠道 文本 图片 视频 音频" },
  { id: "video-model-contracts", label: "视频模型", icon: Clapperboard, group: "系统管理", href: "/settings#video-model-contracts", keywords: "视频 契约 请求 参数 轮询", adminOnly: true },
  { id: "image-object-storage", label: "全局存储", icon: Database, group: "系统管理", href: "/settings#image-object-storage", keywords: "S3 R2 WebDAV 外部存储 配置" },
  { id: "media-storage-governance", label: "媒体清理", icon: Archive, group: "系统管理", href: "/settings#media-storage-governance", keywords: "图片 视频 音频 素材 空间 保留 治理" },
  { id: "announcements", label: "公告发布", icon: Bell, group: "系统管理", href: "/settings#announcements", keywords: "公告 通知 消息", adminOnly: true },
  { id: "prompt-sources", label: "提示词来源", icon: ListChecks, group: "系统管理", href: "/settings#prompt-sources", keywords: "提示词 同步 来源", adminOnly: true },
  { id: "log-governance", label: "日志与清理", icon: ScrollText, group: "系统管理", href: "/settings#log-governance", keywords: "日志 保留 清理 治理" },
  { id: "login-page-image", label: "登录页展示", icon: ImageIcon, group: "系统管理", href: "/settings#login-page-image", keywords: "登录 图片 展示 品牌" },
];

export function getSystemSettingsSections(session: StoredAuthSession) {
  if (!canAccessPath(session, "/settings")) return [];
  return systemSettingsSections.filter((item) => !item.adminOnly || session.role === "admin");
}
