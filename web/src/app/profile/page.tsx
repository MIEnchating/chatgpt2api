"use client";

import { useEffect, useState } from "react";
import { LockKeyhole, LoaderCircle, Save, UserCircle2, UserPen } from "lucide-react";
import { toast } from "sonner";

import { PageHeader } from "@/components/page-header";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Field, FieldDescription, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import {
  changeProfilePassword,
  updateProfileName,
} from "@/lib/api";
import { authSessionFromLoginResponse, setVerifiedAuthSession } from "@/lib/session";
import { useAuthGuard } from "@/lib/use-auth-guard";
import type { StoredAuthSession } from "@/store/auth";

function providerLabel(provider?: string) {
  if (provider === "local") {
    return "本地账号";
  }
  if (provider === "newapi") {
    return "NewAPI";
  }
  if (provider === "linuxdo") {
    return "LinuxDo";
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
  const [isSavingProfile, setIsSavingProfile] = useState(false);
  const [isChangingPassword, setIsChangingPassword] = useState(false);

  const isProfileNameDirty = profileName.trim() !== (currentSession.name || "");
  const roleLabel = sessionRoleLabel(currentSession);

  useEffect(() => {
    setCurrentSession(session);
    setProfileName(session.name || "");
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
                    {providerLabel(currentSession.provider)}
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
