"use client";

import { useEffect, useState } from "react";
import { Eye, EyeOff, KeyRound, LockKeyhole, LoaderCircle, Save, Trash2, UserCircle2, UserPen } from "lucide-react";
import { toast } from "sonner";

import { PageHeader } from "@/components/page-header";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Field, FieldDescription, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import {
  changeProfilePassword,
  clearProfileRelayKey,
  fetchProfileRelayKey,
  updateProfileName,
  updateProfileRelayKey,
  type ProfileRelayKeyStatus,
} from "@/lib/api";
import { clearStoredRelayApiKey, notifyRelayApiKeyChanged, RELAY_PUBLIC_BASE_URL } from "@/lib/relay-key";
import { authSessionFromLoginResponse, setVerifiedAuthSession } from "@/lib/session";
import { useAuthGuard } from "@/lib/use-auth-guard";
import type { StoredAuthSession } from "@/store/auth";

function providerLabel(provider?: string) {
  if (provider === "linuxdo") {
    return "Linuxdo";
  }
  if (provider === "local") {
    return "本地账号";
  }
  return provider || "未知";
}

function sessionRoleLabel(session: StoredAuthSession) {
  if (session.role === "admin") {
    return "管理员";
  }
  return session.roleName || "普通用户";
}

function creationConcurrentLimitLabel(session: StoredAuthSession) {
  if (session.role === "admin" || session.creationConcurrentLimit === 0) {
    return "不限制";
  }
  return `${session.creationConcurrentLimit} 个`;
}

function creationRpmLimitLabel(session: StoredAuthSession) {
  if (session.role === "admin" || session.creationRpmLimit === 0) {
    return "不限制";
  }
  return `${session.creationRpmLimit} 次/分`;
}

type InfoRowProps = {
  label: string;
  value: string;
  code?: boolean;
};

function InfoRow({ label, value, code }: InfoRowProps) {
  return (
    <div className="flex min-w-0 flex-col gap-1 rounded-lg border border-border bg-muted/30 px-3 py-2">
      <span className="text-xs text-muted-foreground">{label}</span>
      {code ? (
        <code className="truncate font-mono text-sm text-foreground">{value || "-"}</code>
      ) : (
        <span className="truncate text-sm font-medium text-foreground">{value || "-"}</span>
      )}
    </div>
  );
}

function ProfileContent({ session }: { session: StoredAuthSession }) {
  const [currentSession, setCurrentSession] = useState(session);
  const [profileName, setProfileName] = useState(session.name || "");
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [relayApiKey, setRelayApiKey] = useState("");
  const [relayKeyStatus, setRelayKeyStatus] = useState<ProfileRelayKeyStatus>({
    has_key: false,
    key_preview: "",
  });
  const [isRelayKeyVisible, setIsRelayKeyVisible] = useState(false);
  const [isSavingProfile, setIsSavingProfile] = useState(false);
  const [isChangingPassword, setIsChangingPassword] = useState(false);
  const [isSavingRelayKey, setIsSavingRelayKey] = useState(false);

  const isProfileNameDirty = profileName.trim() !== (currentSession.name || "");
  const isRelayKeyDirty = relayApiKey.trim() !== "";
  const relayKeyConfigured = relayKeyStatus.has_key;
  const roleLabel = sessionRoleLabel(currentSession);

  useEffect(() => {
    setCurrentSession(session);
    setProfileName(session.name || "");
  }, [session]);

  useEffect(() => {
    let ignore = false;
    clearStoredRelayApiKey();
    void fetchProfileRelayKey()
      .then((status) => {
        if (!ignore) {
          setRelayKeyStatus(status);
          setRelayApiKey("");
        }
      })
      .catch((error) => {
        if (!ignore) {
          toast.error(error instanceof Error ? error.message : "读取 RelayAI Key 状态失败");
        }
      });
    return () => {
      ignore = true;
    };
  }, [session]);

  const handleSaveProfile = async () => {
    const nextName = profileName.trim();
    if (!nextName) {
      toast.error("昵称不能为空");
      return;
    }
    if (!isProfileNameDirty) {
      return;
    }
    setIsSavingProfile(true);
    try {
      const data = await updateProfileName(nextName);
      const nextSession = authSessionFromLoginResponse(data, currentSession.key);
      await setVerifiedAuthSession(nextSession);
      setCurrentSession(nextSession);
      setProfileName(nextSession.name || "");
      toast.success("昵称已保存");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "保存昵称失败");
    } finally {
      setIsSavingProfile(false);
    }
  };

  const handleChangePassword = async () => {
    if (!currentPassword) {
      toast.error("请输入当前密码");
      return;
    }
    if (!newPassword) {
      toast.error("请输入新密码");
      return;
    }
    if (newPassword !== confirmPassword) {
      toast.error("两次输入的新密码不一致");
      return;
    }
    setIsChangingPassword(true);
    try {
      await changeProfilePassword(currentPassword, newPassword);
      setCurrentPassword("");
      setNewPassword("");
      setConfirmPassword("");
      toast.success("密码已修改");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "修改密码失败");
    } finally {
      setIsChangingPassword(false);
    }
  };

  const handleSaveRelayKey = async () => {
    const trimmed = relayApiKey.trim();
    if (!trimmed) {
      toast.error("请输入 RelayAI Key");
      return;
    }
    setIsSavingRelayKey(true);
    try {
      const status = await updateProfileRelayKey(trimmed);
      clearStoredRelayApiKey();
      setRelayKeyStatus(status);
      setRelayApiKey("");
      toast.success("RelayAI Key 已保存");
      notifyRelayApiKeyChanged();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "保存 RelayAI Key 失败");
    } finally {
      setIsSavingRelayKey(false);
    }
  };

  const handleClearRelayKey = async () => {
    setIsSavingRelayKey(true);
    try {
      const status = await clearProfileRelayKey();
      clearStoredRelayApiKey();
      setRelayKeyStatus(status);
      setRelayApiKey("");
      setIsRelayKeyVisible(false);
      toast.success("RelayAI Key 已清除");
      notifyRelayApiKeyChanged();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "清除 RelayAI Key 失败");
    } finally {
      setIsSavingRelayKey(false);
    }
  };

  return (
    <section className="flex flex-col gap-5">
      <PageHeader eyebrow="个人资料" title="个人中心" />

      <div className="grid gap-5 xl:grid-cols-[360px_1fr]">
        <div className="flex flex-col gap-5">
          <Card>
            <CardHeader>
              <div className="flex items-center justify-between gap-3">
                <div className="flex min-w-0 items-center gap-3">
                  <div className="flex size-11 shrink-0 items-center justify-center rounded-2xl bg-primary text-primary-foreground">
                    <UserCircle2 className="size-5" />
                  </div>
                  <div className="min-w-0">
                    <CardTitle className="truncate text-lg">{currentSession.name || "用户"}</CardTitle>
                    <CardDescription className="truncate">{currentSession.subjectId || "-"}</CardDescription>
                  </div>
                </div>
                <Badge variant={currentSession.role === "admin" ? "violet" : "secondary"} className="shrink-0 rounded-md">
                  {roleLabel}
                </Badge>
              </div>
            </CardHeader>
            <CardContent className="flex flex-col gap-3">
              <InfoRow label="用户 ID" value={currentSession.subjectId} code />
              <InfoRow label="登录来源" value={providerLabel(currentSession.provider)} />
              <InfoRow label="角色 ID" value={currentSession.roleId || currentSession.role} code />
              <InfoRow label="创作并发额度" value={creationConcurrentLimitLabel(currentSession)} />
              <InfoRow label="每分钟请求限制" value={creationRpmLimitLabel(currentSession)} />
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <div className="flex min-w-0 items-center gap-3">
                <div className="flex size-11 shrink-0 items-center justify-center rounded-2xl bg-[#edf4ff] text-[#1456f0] dark:bg-sky-950/30 dark:text-sky-300">
                  <LockKeyhole className="size-5" />
                </div>
                <div className="min-w-0">
                  <CardTitle className="text-lg">登录密码</CardTitle>
                  <CardDescription className="truncate">
                    {currentSession.provider === "local" ? "本地账号" : "外部登录"}
                  </CardDescription>
                </div>
              </div>
            </CardHeader>
            <CardContent>
              {currentSession.provider === "local" ? (
                <form
                  onSubmit={(event) => {
                    event.preventDefault();
                    void handleChangePassword();
                  }}
                >
                  <FieldGroup>
                    <Field>
                      <FieldLabel htmlFor="profile-current-password">当前密码</FieldLabel>
                      <Input
                        id="profile-current-password"
                        type="password"
                        autoComplete="current-password"
                        value={currentPassword}
                        onChange={(event) => setCurrentPassword(event.target.value)}
                        className="h-10 rounded-lg"
                      />
                    </Field>
                    <Field>
                      <FieldLabel htmlFor="profile-new-password">新密码</FieldLabel>
                      <Input
                        id="profile-new-password"
                        type="password"
                        autoComplete="new-password"
                        value={newPassword}
                        onChange={(event) => setNewPassword(event.target.value)}
                        className="h-10 rounded-lg"
                      />
                      <FieldDescription>密码长度不能少于 8 位。</FieldDescription>
                    </Field>
                    <Field>
                      <FieldLabel htmlFor="profile-confirm-password">确认新密码</FieldLabel>
                      <Input
                        id="profile-confirm-password"
                        type="password"
                        autoComplete="new-password"
                        value={confirmPassword}
                        onChange={(event) => setConfirmPassword(event.target.value)}
                        className="h-10 rounded-lg"
                      />
                    </Field>
                    <div className="flex justify-end">
                      <Button type="submit" className="h-10 rounded-lg" disabled={isChangingPassword}>
                        {isChangingPassword ? <LoaderCircle className="size-4 animate-spin" /> : <Save className="size-4" />}
                        修改密码
                      </Button>
                    </div>
                  </FieldGroup>
                </form>
              ) : (
                <div className="rounded-xl border border-border bg-muted/30 px-3 py-4 text-sm text-muted-foreground">
                  外部登录账号不使用本地密码。
                </div>
              )}
            </CardContent>
          </Card>
        </div>

        <div className="flex flex-col gap-5">
          <Card>
            <CardHeader>
              <div className="flex min-w-0 items-center gap-3">
                <div className="flex size-11 shrink-0 items-center justify-center rounded-2xl bg-[#edf4ff] text-[#1456f0] dark:bg-sky-950/30 dark:text-sky-300">
                  <UserPen className="size-5" />
                </div>
                <div className="min-w-0">
                  <CardTitle className="text-lg">账号资料</CardTitle>
                  <CardDescription className="truncate">{currentSession.subjectId || "-"}</CardDescription>
                </div>
              </div>
            </CardHeader>
            <CardContent>
              <FieldGroup>
                <Field>
                  <FieldLabel htmlFor="profile-display-name">昵称</FieldLabel>
                  <div className="flex flex-col gap-2 sm:flex-row">
                    <Input
                      id="profile-display-name"
                      value={profileName}
                      onChange={(event) => setProfileName(event.target.value)}
                      placeholder="昵称"
                      className="h-10 rounded-lg"
                    />
                    <Button
                      type="button"
                      variant="outline"
                      className="h-10 rounded-lg"
                      onClick={() => void handleSaveProfile()}
                      disabled={!isProfileNameDirty || isSavingProfile}
                    >
                      {isSavingProfile ? <LoaderCircle className="size-4 animate-spin" /> : <Save className="size-4" />}
                      保存
                    </Button>
                  </div>
                  <FieldDescription>昵称会显示在导航栏和接口调用记录中。</FieldDescription>
                </Field>
              </FieldGroup>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
                <div className="flex min-w-0 items-center gap-3">
                  <div className="flex size-11 shrink-0 items-center justify-center rounded-2xl bg-[#edf4ff] text-[#1456f0] dark:bg-sky-950/30 dark:text-sky-300">
                    <KeyRound className="size-5" />
                  </div>
                  <div className="min-w-0">
                    <CardTitle className="text-lg">RelayAI Key</CardTitle>
                    <CardDescription className="truncate">创作台会自动读取这里保存的 Key</CardDescription>
                  </div>
                </div>
                <Badge variant={relayKeyConfigured ? "success" : "secondary"} className="w-fit rounded-md">
                  {relayKeyConfigured ? "已配置" : "未配置"}
                </Badge>
              </div>
            </CardHeader>
            <CardContent className="flex flex-col gap-5">
              <div className="grid gap-3 md:grid-cols-2">
                <InfoRow label="Base URL" value={RELAY_PUBLIC_BASE_URL} code />
                <InfoRow label="当前状态" value={relayKeyConfigured ? "可以生成图片和对话" : "生成前需要先填写 Key"} />
              </div>

              <FieldGroup>
                <Field>
                  <FieldLabel htmlFor="profile-relay-key">RelayAI Key</FieldLabel>
                  <form
                    className="flex flex-col gap-2 sm:flex-row"
                    onSubmit={(event) => {
                      event.preventDefault();
                      void handleSaveRelayKey();
                    }}
                  >
                    <div className="relative min-w-0 flex-1">
                      <Input
                        id="profile-relay-key"
                        type={isRelayKeyVisible ? "text" : "password"}
                        value={relayApiKey}
                        onChange={(event) => setRelayApiKey(event.target.value)}
                        placeholder="sk-..."
                        className="h-10 rounded-lg pr-10"
                        autoComplete="off"
                      />
                      <button
                        type="button"
                        className="absolute top-1/2 right-2 inline-flex size-8 -translate-y-1/2 items-center justify-center rounded-md text-muted-foreground transition hover:bg-accent hover:text-foreground"
                        onClick={() => setIsRelayKeyVisible((visible) => !visible)}
                        aria-label={isRelayKeyVisible ? "隐藏 Key" : "显示 Key"}
                        title={isRelayKeyVisible ? "隐藏" : "显示"}
                      >
                        {isRelayKeyVisible ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
                      </button>
                    </div>
                    <Button type="submit" className="h-10 rounded-lg" disabled={!isRelayKeyDirty || isSavingRelayKey}>
                      {isSavingRelayKey ? <LoaderCircle className="size-4 animate-spin" /> : <Save className="size-4" />}
                      保存
                    </Button>
                  </form>
                  <FieldDescription>
                    Key 按当前登录用户保存在服务端；页面显示固定公网地址，实际请求由服务端转发到管理员配置的映射地址。
                  </FieldDescription>
                </Field>
              </FieldGroup>

              <div className="flex min-w-0 flex-col gap-2 rounded-xl border border-border bg-muted/30 p-3">
                <div className="flex items-center justify-between gap-3 text-xs text-muted-foreground">
                  <span>已保存的 Key</span>
                  <span>{relayKeyConfigured ? "服务端已保存" : "尚未保存"}</span>
                </div>
                <div className="flex min-w-0 flex-col gap-2 sm:flex-row sm:items-center">
                  <code className="min-w-0 flex-1 truncate rounded-lg bg-background px-3 py-2 font-mono text-sm text-foreground">
                    {relayKeyStatus.key_preview || "未配置"}
                  </code>
                  <div className="flex shrink-0 items-center gap-2">
                    <Button
                      type="button"
                      variant="outline"
                      className="h-9 rounded-lg border-rose-200 px-3 text-rose-600 hover:bg-rose-50 hover:text-rose-700"
                      onClick={() => void handleClearRelayKey()}
                      disabled={!relayKeyConfigured || isSavingRelayKey}
                    >
                      <Trash2 className="size-4" />
                      清除
                    </Button>
                  </div>
                </div>
              </div>
            </CardContent>
          </Card>
        </div>
      </div>
    </section>
  );
}

export default function ProfilePage() {
  const { isCheckingAuth, session } = useAuthGuard(undefined, "/profile");
  if (isCheckingAuth || !session) {
    return (
      <div className="flex min-h-[40vh] items-center justify-center">
        <LoaderCircle className="size-5 animate-spin text-stone-400" />
      </div>
    );
  }
  return <ProfileContent session={session} />;
}
