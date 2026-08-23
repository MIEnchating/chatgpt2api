"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  AlertCircle,
  Clapperboard,
  Image as ImageIcon,
  KeyRound,
  LoaderCircle,
  RefreshCw,
  UserCircle2,
  WalletCards,
} from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import {
  fetchProfileBalance,
  fetchProfileRelayKey,
  PROFILE_RELAY_TOKEN_NAME_CHANGED_EVENT,
  type ProfileBalanceStatus,
  type ProfileRelayKeyStatus,
} from "@/lib/api";
import { displaySubjectId } from "@/lib/session";
import {
  getStoredRelayTokenName,
  relayTokenNameStorageKey,
  retainSelectedRelayTokenName,
  storeRelayTokenName,
  type RelayTokenKind,
} from "@/lib/relay-token-selection";
import { useAuthGuard } from "@/lib/use-auth-guard";
import type { StoredAuthSession } from "@/store/auth";

function providerLabel(provider?: string) {
  if (provider === "local") {
    return "本地账号";
  }
  if (provider === "newapi") {
    return "云棉";
  }
  if (provider === "sub2api") {
    return "Sub2API";
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

function normalizeTokenNames(values: unknown) {
  return Array.isArray(values)
    ? Array.from(new Set(values.map((name) => String(name || "").trim()).filter(Boolean)))
    : [];
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

function RelayKeyPreference({
  isLoading,
  kind,
  onChange,
  selectedTokenName,
  status,
  tokenNameOptions,
}: {
  isLoading: boolean;
  kind: RelayTokenKind;
  onChange: (value: string) => void;
  selectedTokenName: string;
  status: ProfileRelayKeyStatus | null;
  tokenNameOptions: string[];
}) {
  const Icon = kind === "image" ? ImageIcon : Clapperboard;
  const title = kind === "image" ? "图片生成 Key" : "视频生成 Key";
  const activeTokenName = tokenNameOptions.includes(selectedTokenName) ? selectedTokenName : "";
  const statusText = !activeTokenName
    ? tokenNameOptions.length > 0 ? "请选择 Key" : "暂无可用 Key"
    : isLoading
      ? "正在读取密钥"
      : status?.has_key
        ? status.key_preview || "密钥可用"
        : status?.message || "未读取到可用密钥";

  return (
    <div className="min-w-0 rounded-lg border border-border/80 bg-background p-4">
      <div className="mb-3 flex items-center gap-2.5">
        <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground">
          <Icon className="size-4" />
        </span>
        <div className="min-w-0">
          <h3 className="text-sm font-semibold text-foreground">{title}</h3>
          <p className="text-xs text-muted-foreground">用于全站{kind === "image" ? "图片" : "视频"}任务</p>
        </div>
      </div>
      <Select
        value={activeTokenName || undefined}
        onValueChange={onChange}
        disabled={tokenNameOptions.length === 0}
      >
        <SelectTrigger className="h-10 rounded-lg bg-background shadow-none">
          <KeyRound className="size-4 text-muted-foreground" />
          <SelectValue placeholder={tokenNameOptions.length > 0 ? "请选择 Key" : "无可用 Key"} />
        </SelectTrigger>
        <SelectContent>
          {tokenNameOptions.map((name) => (
            <SelectItem key={name} value={name}>{name}</SelectItem>
          ))}
        </SelectContent>
      </Select>
      <div className="mt-3 flex min-w-0 items-center gap-2 text-xs text-muted-foreground">
        <span className={`size-1.5 shrink-0 rounded-full ${activeTokenName && status?.has_key ? "bg-emerald-500" : "bg-amber-500"}`} />
        <code className="truncate font-mono" title={statusText}>{statusText}</code>
      </div>
    </div>
  );
}

function AccountResourcesCard({
  balance,
  isLoading,
  isLoadingRelayKeys,
  onRefresh,
  onTokenNameChange,
  relayKeyStatuses,
  selectedTokenNames,
  tokenNameOptions,
}: {
  balance: ProfileBalanceStatus | null;
  isLoading: boolean;
  isLoadingRelayKeys: boolean;
  onRefresh: () => void;
  onTokenNameChange: (kind: RelayTokenKind, value: string) => void;
  relayKeyStatuses: Record<RelayTokenKind, ProfileRelayKeyStatus | null>;
  selectedTokenNames: Record<RelayTokenKind, string>;
  tokenNameOptions: string[];
}) {
  return (
    <Card>
      <CardHeader>
        <div className="flex items-start justify-between gap-3">
          <div className="flex min-w-0 items-center gap-3">
            <div className="flex size-11 shrink-0 items-center justify-center rounded-2xl bg-[#edf4ff] text-[#1456f0] dark:bg-sky-950/30 dark:text-sky-300">
              <WalletCards className="size-5" />
            </div>
            <div className="min-w-0">
              <CardTitle className="text-lg">账户资源</CardTitle>
              <p className="mt-1 text-sm text-muted-foreground">余额概览与全站 Key 选择</p>
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
      <CardContent className="space-y-5">
        {isLoading ? (
          <div className="flex min-h-24 items-center justify-center rounded-lg border border-border bg-muted/30 text-sm text-muted-foreground">
            <LoaderCircle className="mr-2 size-4 animate-spin" />
            正在读取余额
          </div>
        ) : balance?.has_balance ? (
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
            <InfoRow label="当前余额" value={formatYunMianQuota(balance.quota)} />
            <InfoRow label="已用额度" value={formatYunMianQuota(balance.used_quota)} />
            <InfoRow label="请求次数" value={formatNumber(balance.request_count)} />
            <InfoRow label="邮箱" value={balance.email || "-"} />
          </div>
        ) : (
          <div className="flex min-h-24 items-center gap-3 rounded-lg border border-border bg-muted/30 px-3 py-4 text-sm text-muted-foreground">
            <AlertCircle className="size-4 shrink-0" />
            <span>{balance?.message || "未读取到云棉用户余额"}</span>
          </div>
        )}
        <div className="border-t border-border/70 pt-5">
          <div className="mb-3">
            <h2 className="text-sm font-semibold text-foreground">选择 Key</h2>
            <p className="mt-1 text-xs text-muted-foreground">图片与视频任务分别使用所选 Key，修改其中一项不会影响另一项。</p>
          </div>
          <div className="grid gap-3 md:grid-cols-2">
            {(["image", "video"] as const).map((kind) => (
              <RelayKeyPreference
                key={kind}
                kind={kind}
                isLoading={isLoadingRelayKeys}
                selectedTokenName={selectedTokenNames[kind]}
                status={relayKeyStatuses[kind]}
                tokenNameOptions={tokenNameOptions}
                onChange={(value) => onTokenNameChange(kind, value)}
              />
            ))}
          </div>
          {balance?.token_message ? (
            <div className="mt-3 flex min-h-10 items-center gap-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800 dark:border-amber-900/60 dark:bg-amber-950/30 dark:text-amber-200">
              <AlertCircle className="size-4 shrink-0" />
              <span>{balance.token_message}</span>
            </div>
          ) : null}
        </div>
      </CardContent>
    </Card>
  );
}

function ProfileContent({ session }: { session: StoredAuthSession }) {
  const [balance, setBalance] = useState<ProfileBalanceStatus | null>(null);
  const [relayKeyStatuses, setRelayKeyStatuses] = useState<Record<RelayTokenKind, ProfileRelayKeyStatus | null>>({
    image: null,
    video: null,
  });
  const relayTokenStorageKeys = useMemo(() => ({
    image: relayTokenNameStorageKey(session, "image"),
    video: relayTokenNameStorageKey(session, "video"),
  }), [session]);
  const [selectedTokenNames, setSelectedTokenNames] = useState<Record<RelayTokenKind, string>>(() => ({
    image: getStoredRelayTokenName(session, "image"),
    video: getStoredRelayTokenName(session, "video"),
  }));
  const [isLoadingBalance, setIsLoadingBalance] = useState(true);
  const [isLoadingRelayKeys, setIsLoadingRelayKeys] = useState(false);

  const selectRelayTokenName = useCallback((kind: RelayTokenKind, value: string) => {
    const normalizedName = value.trim();
    storeRelayTokenName(session, kind, normalizedName);
    setSelectedTokenNames((current) => ({ ...current, [kind]: normalizedName }));
    window.dispatchEvent(
      new CustomEvent(PROFILE_RELAY_TOKEN_NAME_CHANGED_EVENT, { detail: { kind, tokenName: normalizedName } }),
    );
  }, [session]);

  const roleLabel = sessionRoleLabel(session);
  const subjectId = displaySubjectId(session.subjectId, session.provider);
  const tokenNameOptions = useMemo(
    () => normalizeTokenNames([
      ...(relayKeyStatuses.image?.token_names || []),
      ...(relayKeyStatuses.video?.token_names || []),
      ...(balance?.token_names || []),
    ]),
    [balance?.token_names, relayKeyStatuses.image?.token_names, relayKeyStatuses.video?.token_names],
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
    if (isLoadingBalance || isLoadingRelayKeys) {
      return;
    }
    (["image", "video"] as const).forEach((kind) => {
      const retainedName = retainSelectedRelayTokenName(selectedTokenNames[kind], tokenNameOptions);
      if (retainedName !== selectedTokenNames[kind]) selectRelayTokenName(kind, retainedName);
    });
  }, [
    isLoadingBalance,
    isLoadingRelayKeys,
    selectRelayTokenName,
    selectedTokenNames,
    tokenNameOptions,
  ]);

  useEffect(() => {
    setSelectedTokenNames({
      image: getStoredRelayTokenName(session, "image"),
      video: getStoredRelayTokenName(session, "video"),
    });
  }, [relayTokenStorageKeys.image, relayTokenStorageKeys.video, session]);

  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }
    const handleTokenNameChange = (event: Event) => {
      if (event instanceof StorageEvent) {
        const kind = event.key === relayTokenStorageKeys.image
          ? "image"
          : event.key === relayTokenStorageKeys.video ? "video" : null;
        if (!kind) return;
        setSelectedTokenNames((current) => ({
          ...current,
          [kind]: getStoredRelayTokenName(session, kind),
        }));
        return;
      }
      const detail = (event as CustomEvent<{ kind?: RelayTokenKind; tokenName?: string }>).detail;
      if (!detail?.kind) return;
      setSelectedTokenNames((current) => ({
        ...current,
        [detail.kind!]: String(detail.tokenName ?? getStoredRelayTokenName(session, detail.kind!)).trim(),
      }));
    };
    window.addEventListener(PROFILE_RELAY_TOKEN_NAME_CHANGED_EVENT, handleTokenNameChange);
    window.addEventListener("storage", handleTokenNameChange);
    return () => {
      window.removeEventListener(PROFILE_RELAY_TOKEN_NAME_CHANGED_EVENT, handleTokenNameChange);
      window.removeEventListener("storage", handleTokenNameChange);
    };
  }, [relayTokenStorageKeys.image, relayTokenStorageKeys.video, session]);

  useEffect(() => {
    let ignore = false;
    setIsLoadingRelayKeys(true);
    void Promise.all([
      fetchProfileRelayKey(undefined, selectedTokenNames.image),
      fetchProfileRelayKey(undefined, selectedTokenNames.video),
    ])
      .then(([image, video]) => {
        if (!ignore) setRelayKeyStatuses({ image, video });
      })
      .catch((error) => {
        if (ignore) return;
        const status: ProfileRelayKeyStatus = {
          has_key: false,
          key_preview: "",
          source: "newapi",
          message: error instanceof Error ? error.message : "读取云棉密钥失败",
        };
        setRelayKeyStatuses({ image: status, video: status });
      })
      .finally(() => {
        if (!ignore) setIsLoadingRelayKeys(false);
      });
    return () => {
      ignore = true;
    };
  }, [session.key, selectedTokenNames.image, selectedTokenNames.video]);

  useEffect(() => {
    void loadBalance();
  }, [session.key, loadBalance]);

  return (
    <section className="h-full min-h-0 overflow-y-auto overscroll-contain pb-8 pr-1 [scrollbar-gutter:stable]">
      <div className="mx-auto flex w-full max-w-[1120px] flex-col gap-5">
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
            <CardContent className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
              <InfoRow label="用户 ID" value={subjectId} code />
              <InfoRow label="登录来源" value={providerLabel(session.provider)} />
              <InfoRow label="创作并发额度" value={creationConcurrentLimitLabel(session)} />
              <InfoRow label="每分钟请求限制" value={creationRpmLimitLabel(session)} />
            </CardContent>
          </Card>
          <AccountResourcesCard
            balance={balance}
            isLoading={isLoadingBalance}
            isLoadingRelayKeys={isLoadingRelayKeys}
            relayKeyStatuses={relayKeyStatuses}
            selectedTokenNames={selectedTokenNames}
            tokenNameOptions={tokenNameOptions}
            onTokenNameChange={selectRelayTokenName}
            onRefresh={() => void loadBalance()}
          />
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
