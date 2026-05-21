"use client";

import { useCallback, useEffect, useState } from "react";
import { AlertCircle, LoaderCircle, RefreshCw, Save, UserCircle2, UserPen, WalletCards } from "lucide-react";
import { toast } from "sonner";

import { PageHeader } from "@/components/page-header";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Field, FieldDescription, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import {
  fetchProfileBalance,
  type ProfileBalanceStatus,
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

function formatNumber(value: number | undefined) {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return "-";
  }
  return new Intl.NumberFormat("zh-CN").format(value);
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

function BalanceCard({
  balance,
  isLoading,
  onRefresh,
}: {
  balance: ProfileBalanceStatus | null;
  isLoading: boolean;
  onRefresh: () => void;
}) {
  const title = balance?.has_balance ? balance.display_name || balance.username || "NewAPI 用户" : "NewAPI";

  return (
    <Card>
      <CardHeader>
        <div className="flex items-start justify-between gap-3">
          <div className="flex min-w-0 items-center gap-3">
            <div className="flex size-11 shrink-0 items-center justify-center rounded-2xl bg-[#edf4ff] text-[#1456f0] dark:bg-sky-950/30 dark:text-sky-300">
              <WalletCards className="size-5" />
            </div>
            <div className="min-w-0">
              <CardTitle className="text-lg">用户余额</CardTitle>
              <CardDescription className="truncate">{title}</CardDescription>
            </div>
          </div>
          <Button
            type="button"
            variant="outline"
            size="icon"
            className="size-10 shrink-0 rounded-lg"
            onClick={onRefresh}
            disabled={isLoading}
            aria-label="刷新余额"
            title="刷新余额"
          >
            {isLoading ? <LoaderCircle className="size-4 animate-spin" /> : <RefreshCw className="size-4" />}
          </Button>
        </div>
      </CardHeader>
      <CardContent>
        {isLoading ? (
          <div className="flex min-h-24 items-center justify-center rounded-lg border border-border bg-muted/30 text-sm text-muted-foreground">
            <LoaderCircle className="mr-2 size-4 animate-spin" />
            正在读取余额
          </div>
        ) : balance?.has_balance ? (
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
            <InfoRow label="当前余额" value={formatNumber(balance.quota)} />
            <InfoRow label="已用额度" value={formatNumber(balance.used_quota)} />
            <InfoRow label="请求次数" value={formatNumber(balance.request_count)} />
            <InfoRow label="用户分组" value={balance.user_group || "-"} />
            <InfoRow label="令牌分组" value={balance.token_group || "-"} />
            <InfoRow label="NewAPI 用户名" value={balance.username || "-"} code />
            <InfoRow label="邮箱" value={balance.email || "-"} />
            <InfoRow label="NewAPI 用户 ID" value={balance.user_id ? String(balance.user_id) : "-"} code />
          </div>
        ) : (
          <div className="flex min-h-24 items-center gap-3 rounded-lg border border-border bg-muted/30 px-3 py-4 text-sm text-muted-foreground">
            <AlertCircle className="size-4 shrink-0" />
            <span>{balance?.message || "未读取到 NewAPI 用户余额"}</span>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function ProfileContent({ session }: { session: StoredAuthSession }) {
  const [currentSession, setCurrentSession] = useState(session);
  const [profileName, setProfileName] = useState(session.name || "");
  const [balance, setBalance] = useState<ProfileBalanceStatus | null>(null);
  const [isSavingProfile, setIsSavingProfile] = useState(false);
  const [isLoadingBalance, setIsLoadingBalance] = useState(true);

  const isProfileNameDirty = profileName.trim() !== (currentSession.name || "");
  const roleLabel = sessionRoleLabel(currentSession);

  useEffect(() => {
    setCurrentSession(session);
    setProfileName(session.name || "");
  }, [session]);

  const loadBalance = useCallback(async () => {
    setIsLoadingBalance(true);
    try {
      setBalance(await fetchProfileBalance());
    } catch (error) {
      setBalance({
        has_balance: false,
        source: "newapi",
        message: error instanceof Error ? error.message : "读取 NewAPI 用户余额失败",
      });
    } finally {
      setIsLoadingBalance(false);
    }
  }, []);

  useEffect(() => {
    void loadBalance();
  }, [currentSession.key, loadBalance]);

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
        </div>

        <div className="flex flex-col gap-5">
          <BalanceCard balance={balance} isLoading={isLoadingBalance} onRefresh={() => void loadBalance()} />

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
