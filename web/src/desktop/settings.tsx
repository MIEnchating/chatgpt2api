import { useEffect, useRef, useState, type FormEvent } from "react";
import { ArrowRight, Monitor, Server } from "lucide-react";

import { LabeledField } from "@/components/labeled-field";
import { PasswordInput } from "@/components/password-input";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Field, FieldContent, FieldDescription, FieldGroup, FieldLabel, FieldLegend, FieldSet, FieldTitle } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { LoadingState } from "@/components/ui/loading-state";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Spinner } from "@/components/ui/spinner";
import { TooltipProvider } from "@/components/ui/tooltip";

type ConnectionMode = "local" | "remote";
type ConnectionSettings = {
  mode: ConnectionMode;
  remoteURL: string;
  needsPassword: boolean;
  dataDirectory: string;
  statusMessage: string;
  development: boolean;
  connecting: boolean;
};
type ConnectionInput = { mode: ConnectionMode; remoteURL: string; adminPassword: string };

declare global {
  interface Window {
    desktopConnection: {
      settings: () => Promise<ConnectionSettings>;
      connect: (input: ConnectionInput) => Promise<{ ok: boolean; error?: string }>;
    };
  }
}

export function DesktopConnectionSettings() {
  const [settings, setSettings] = useState<ConnectionSettings | null>(null);
  const [mode, setMode] = useState<ConnectionMode>("local");
  const [remoteURL, setRemoteURL] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [attempted, setAttempted] = useState(false);
  const passwordRef = useRef<HTMLInputElement>(null);
  const connectingRef = useRef(false);
  const local = mode === "local";

  useEffect(() => {
    const theme = window.matchMedia("(prefers-color-scheme: dark)");
    const updateTheme = () => document.documentElement.classList.toggle("dark", theme.matches);
    updateTheme();
    theme.addEventListener("change", updateTheme);
    let active = true;
    void window.desktopConnection.settings().then((value) => {
      if (!active) return;
      setSettings(value);
      setMode(value.mode);
      setRemoteURL(value.remoteURL);
      setError(value.statusMessage);
      setBusy(value.connecting);
    }).catch((reason: unknown) => {
      if (active) setError(reason instanceof Error ? reason.message : "无法读取连接设置");
    }).finally(() => { if (active) setLoading(false); });
    return () => { active = false; theme.removeEventListener("change", updateTheme); };
  }, []);

  async function connect(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (connectingRef.current || busy || !settings) return;
    connectingRef.current = true;
    const input: ConnectionInput = { mode, remoteURL: local ? "" : remoteURL, adminPassword: local ? passwordRef.current?.value || "" : "" };
    if (passwordRef.current) passwordRef.current.value = "";
    setBusy(true);
    setError("");
    setAttempted(true);
    try {
      const result = await window.desktopConnection.connect(input);
      if (!result.ok) setError(result.error || "连接失败，请重试");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "连接失败，请重试");
    } finally {
      input.adminPassword = "";
      connectingRef.current = false;
      setBusy(false);
    }
  }

  return <TooltipProvider><ScrollArea className="h-dvh" contentClassName="mx-auto flex min-h-dvh w-full max-w-xl flex-col justify-center gap-5 px-5 py-8 sm:px-8">
    <header className="flex items-center gap-2 text-sm font-medium">chatgpt2api <Badge variant="secondary">桌面版</Badge></header>
    <Card>
      <CardHeader>
        <CardTitle><h1>连接你的创作空间</h1></CardTitle>
        <CardDescription>在这台电脑上开始创作，或连接已有的服务器。</CardDescription>
      </CardHeader>
      <CardContent>
        <form id="connection-form" onSubmit={(event) => void connect(event)}>
          <FieldSet disabled={loading || busy || !settings}>
            <FieldSet>
              <FieldLegend variant="label">运行方式</FieldLegend>
              <RadioGroup name="mode" value={mode} disabled={loading || busy || !settings} onValueChange={(value) => setMode(value as ConnectionMode)}>
                <FieldLabel htmlFor="mode-local"><Field orientation="horizontal">
                  <RadioGroupItem id="mode-local" value="local" />
                  <FieldContent><FieldTitle><Monitor aria-hidden="true" className="size-4" />本机空间</FieldTitle><FieldDescription>{settings?.development ? "复用现有 Vite 8002 和 Go 8090 源码服务。" : "数据保存在这台电脑，关闭应用后服务随之停止。"}</FieldDescription></FieldContent>
                </Field></FieldLabel>
                <FieldLabel htmlFor="mode-remote"><Field orientation="horizontal">
                  <RadioGroupItem id="mode-remote" value="remote" />
                  <FieldContent><FieldTitle><Server aria-hidden="true" className="size-4" />远程服务器</FieldTitle><FieldDescription>连接现有服务，使用服务器上的账号和数据。</FieldDescription></FieldContent>
                </Field></FieldLabel>
              </RadioGroup>
            </FieldSet>
            {!local ? <LabeledField label="服务器地址" description="仅填写域名和端口，例如 https://canvas.example.com:8443。除本机地址外必须使用 HTTPS。">{(id) => <Input id={id} type="url" required autoComplete="url" placeholder="https://canvas.example.com" value={remoteURL} onChange={(event) => setRemoteURL(event.target.value)} />}</LabeledField> : null}
            {local && settings?.needsPassword ? <LabeledField label="设置管理员密码" description="账号为 admin。密码至少 12 个字符，最多 72 个 UTF-8 字节（汉字通常占 3 字节）。连接设置不会保存密码。">{(id) => <PasswordInput id={id} ref={passwordRef} required minLength={12} maxLength={72} disabled={busy} autoComplete="new-password" placeholder="至少 12 个字符" />}</LabeledField> : null}
            {local && settings ? <FieldGroup><Field><FieldTitle>本地数据目录</FieldTitle><FieldDescription className="break-all">{settings.dataDirectory}</FieldDescription></Field></FieldGroup> : null}
            <Button id="connect" type="submit" disabled={loading || busy || !settings} aria-busy={busy} className="w-full">{busy ? <Spinner /> : null}{busy ? "正在连接" : attempted ? "重试连接" : "打开创作空间"}{!busy ? <ArrowRight aria-hidden="true" /> : null}</Button>
          </FieldSet>
          {loading ? <LoadingState compact label="正在读取连接设置…" className="mt-4" /> : busy ? <LoadingState compact className="mt-4" label={local && !settings?.development ? "正在启动本地空间，首次启动可能需要一些时间…" : "正在连接服务器…"} /> : null}
          {error ? <Alert variant="destructive" className="mt-4"><AlertDescription>{error}</AlertDescription></Alert> : null}
        </form>
      </CardContent>
    </Card>
    <p className="text-center text-xs leading-5 text-muted-foreground">之后可在顶部菜单的「连接设置」中切换空间。</p>
  </ScrollArea></TooltipProvider>;
}
