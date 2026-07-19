"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { AlertCircle, LoaderCircle, RefreshCw, UserCircle2, WalletCards } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import {
  fetchProfileBalance,
  fetchProfileRelayKey,
  PROFILE_RELAY_TOKEN_NAME_CHANGED_EVENT,
  PROFILE_RELAY_TOKEN_NAME_STORAGE_KEY,
  PROFILE_RELAY_TOKEN_GROUP_CHANGED_EVENT,
  PROFILE_RELAY_TOKEN_GROUP_STORAGE_KEY,
  type ProfileBalanceStatus,
  type ProfileRelayKeyStatus,
} from "@/lib/api";
import { displaySubjectId } from "@/lib/session";
import { useAuthGuard } from "@/lib/use-auth-guard";
import type { StoredAuthSession } from "@/store/auth";

function providerLabel(provider?: string) {
  if (provider === "local") {
    return "本地账号";
  }
  if (provider === "newapi") {
    return "云棉";
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

function formatYunMianQuota(value: number | undefined) {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return "-";
  }
  return new Intl.NumberFormat("zh-CN", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(value / 500000);
}

function getStoredRelayTokenName() {
  if (typeof window === "undefined") {
    return "";
  }
  return window.localStorage.getItem(PROFILE_RELAY_TOKEN_NAME_STORAGE_KEY) || "";
}

function normalizeTokenNames(values: unknown) {
  return Array.isArray(values)
    ? Array.from(new Set(values.map((name) => String(name || "").trim()).filter(Boolean)))
    : [];
}

function nextTokenNameForOptions(current: string, options: string[], fallback?: string) {
  const candidates = [current, fallback].map((name) => String(name || "").trim()).filter(Boolean);
  return candidates.find((name) => options.includes(name)) || options[0] || "";
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
  isLoadingRelayKey,
  onRefresh,
  onTokenNameChange,
  relayKeyStatus,
  selectedTokenName,
  tokenNameOptions,
}: {
  balance: ProfileBalanceStatus | null;
  isLoading: boolean;
  isLoadingRelayKey: boolean;
  onRefresh: () => void;
  onTokenNameChange: (value: string) => void;
  relayKeyStatus: ProfileRelayKeyStatus | null;
  selectedTokenName: string;
  tokenNameOptions: string[];
}) {
  const activeTokenName = tokenNameOptions.includes(selectedTokenName) ? selectedTokenName : "";
  const keyStatusText = isLoadingRelayKey
    ? "正在读取密钥"
    : relayKeyStatus?.has_key
      ? relayKeyStatus.key_preview || "已读取"
      : relayKeyStatus?.message || balance?.token_message || "未读取到可用密钥";

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
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
            <InfoRow label="当前余额" value={formatYunMianQuota(balance.quota)} />
            <InfoRow label="已用额度" value={formatYunMianQuota(balance.used_quota)} />
            <InfoRow label="请求次数" value={formatNumber(balance.request_count)} />
            <div className="flex min-w-0 flex-col gap-1 rounded-lg border border-border bg-muted/30 px-3 py-2">
              <span className="text-xs text-muted-foreground">Key 名称</span>
              <Select
                value={activeTokenName || undefined}
                onValueChange={onTokenNameChange}
                disabled={tokenNameOptions.length === 0}
              >
                <SelectTrigger className="h-8 rounded-lg bg-background px-2.5 text-sm font-medium shadow-none">
                  <SelectValue placeholder="无可用 Key" />
                </SelectTrigger>
                <SelectContent>
                  {tokenNameOptions.map((name) => (
                    <SelectItem key={name} value={name}>
                      {name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <InfoRow label="当前密钥" value={keyStatusText} code />
            <InfoRow label="邮箱" value={balance.email || "-"} />
            {!relayKeyStatus?.has_key && (balance.token_message || relayKeyStatus?.message) ? (
              <div className="sm:col-span-2 xl:col-span-3">
                <div className="flex min-h-10 items-center gap-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800">
                  <AlertCircle className="size-4 shrink-0" />
                  <span>{relayKeyStatus?.message || balance.token_message}</span>
                </div>
              </div>
            ) : null}
          </div>
        ) : (
          <div className="flex min-h-24 items-center gap-3 rounded-lg border border-border bg-muted/30 px-3 py-4 text-sm text-muted-foreground">
            <AlertCircle className="size-4 shrink-0" />
            <span>{balance?.message || "未读取到云棉用户余额"}</span>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function ProfileContent({ session }: { session: StoredAuthSession }) {
  const [balance, setBalance] = useState<ProfileBalanceStatus | null>(null);
  const [relayKeyStatus, setRelayKeyStatus] = useState<ProfileRelayKeyStatus | null>(null);
  const [selectedTokenName, setSelectedTokenName] = useState(getStoredRelayTokenName);
  const [isLoadingBalance, setIsLoadingBalance] = useState(true);
  const [isLoadingRelayKey, setIsLoadingRelayKey] = useState(false);

  const roleLabel = sessionRoleLabel(session);
  const subjectId = displaySubjectId(session.subjectId, session.provider);
  const tokenNameOptions = useMemo(
    () => normalizeTokenNames([...(relayKeyStatus?.token_names || []), ...(balance?.token_names || [])]),
    [balance?.token_names, relayKeyStatus?.token_names],
  );
  const loadBalance = useCallback(async () => {
    setIsLoadingBalance(true);
    try {
      const nextBalance = await fetchProfileBalance();
      setBalance(nextBalance);
    } catch (error) {
      setBalance({
        has_balance: false,
        source: "newapi",
        message: error instanceof Error ? error.message : "读取云棉用户余额失败",
      });
    } finally {
      setIsLoadingBalance(false);
    }
  }, []);

  useEffect(() => {
    if (isLoadingBalance || isLoadingRelayKey) {
      return;
    }
    setSelectedTokenName((current) =>
      nextTokenNameForOptions(current, tokenNameOptions, relayKeyStatus?.token_name || balance?.token_name),
    );
  }, [
    balance?.token_name,
    isLoadingBalance,
    isLoadingRelayKey,
    relayKeyStatus?.token_name,
    tokenNameOptions,
  ]);

  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }
    const handleTokenNameChange = (event: Event) => {
      if (event instanceof StorageEvent && event.key !== PROFILE_RELAY_TOKEN_NAME_STORAGE_KEY) {
        return;
      }
      const eventName = (event as CustomEvent<{ tokenName?: string }>).detail?.tokenName;
      setSelectedTokenName(String(eventName ?? getStoredRelayTokenName()).trim());
    };
    window.addEventListener(PROFILE_RELAY_TOKEN_NAME_CHANGED_EVENT, handleTokenNameChange);
    window.addEventListener("storage", handleTokenNameChange);
    return () => {
      window.removeEventListener(PROFILE_RELAY_TOKEN_NAME_CHANGED_EVENT, handleTokenNameChange);
      window.removeEventListener("storage", handleTokenNameChange);
    };
  }, []);

  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }
    const normalizedName = selectedTokenName.trim();
    if (normalizedName) {
      window.localStorage.setItem(PROFILE_RELAY_TOKEN_NAME_STORAGE_KEY, normalizedName);
    } else {
      window.localStorage.removeItem(PROFILE_RELAY_TOKEN_NAME_STORAGE_KEY);
    }
    window.dispatchEvent(
      new CustomEvent(PROFILE_RELAY_TOKEN_NAME_CHANGED_EVENT, { detail: { tokenName: normalizedName } }),
    );
  }, [selectedTokenName]);

  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }
    window.localStorage.removeItem(PROFILE_RELAY_TOKEN_GROUP_STORAGE_KEY);
    window.dispatchEvent(new CustomEvent(PROFILE_RELAY_TOKEN_GROUP_CHANGED_EVENT, { detail: { tokenGroup: "" } }));
  }, []);

  useEffect(() => {
    let ignore = false;
    setIsLoadingRelayKey(true);
    void fetchProfileRelayKey(undefined, selectedTokenName)
      .then((status) => {
        if (ignore) {
          return;
        }
        setRelayKeyStatus(status);
      })
      .catch((error) => {
        if (ignore) {
          return;
        }
        setRelayKeyStatus({
          has_key: false,
          key_preview: "",
          source: "newapi",
          message: error instanceof Error ? error.message : "读取云棉密钥失败",
        });
      })
      .finally(() => {
        if (!ignore) {
          setIsLoadingRelayKey(false);
        }
      });
    return () => {
      ignore = true;
    };
  }, [session.key, selectedTokenName]);

  useEffect(() => {
    void loadBalance();
  }, [session.key, loadBalance]);

  return (
    <section className="flex h-full min-h-0 flex-col gap-5 overflow-y-auto overscroll-contain pb-8 pr-1 [scrollbar-gutter:stable]">
      <div className="grid gap-5 xl:grid-cols-[320px_minmax(0,1fr)]">
        <div className="flex flex-col gap-5">
          <Card>
            <CardHeader>
              <div className="flex items-center justify-between gap-3">
                <div className="flex min-w-0 items-center gap-3">
                  <div className="flex size-11 shrink-0 items-center justify-center rounded-2xl bg-primary text-primary-foreground">
                    <UserCircle2 className="size-5" />
                  </div>
                  <div className="min-w-0">
                    <CardTitle className="truncate text-lg">{session.name || "用户"}</CardTitle>
                  </div>
                </div>
                <Badge variant={session.role === "admin" ? "violet" : "secondary"} className="shrink-0 rounded-md">
                  {roleLabel}
                </Badge>
              </div>
            </CardHeader>
            <CardContent className="flex flex-col gap-3">
              <InfoRow label="用户 ID" value={subjectId} code />
              <InfoRow label="登录来源" value={providerLabel(session.provider)} />
              <InfoRow label="创作并发额度" value={creationConcurrentLimitLabel(session)} />
              <InfoRow label="每分钟请求限制" value={creationRpmLimitLabel(session)} />
            </CardContent>
          </Card>
        </div>

        <div className="flex flex-col gap-5">
          <BalanceCard
            balance={balance}
            isLoading={isLoadingBalance}
            isLoadingRelayKey={isLoadingRelayKey}
            relayKeyStatus={relayKeyStatus}
            selectedTokenName={selectedTokenName}
            tokenNameOptions={tokenNameOptions}
            onTokenNameChange={setSelectedTokenName}
            onRefresh={() => void loadBalance()}
          />
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
