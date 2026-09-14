"use client";

import { useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  ArrowRight,
  KeyRound,
  LoaderCircle,
  ShieldCheck,
  UserRound,
} from "lucide-react";
import { toast } from "sonner";

import { ThemeToggle } from "@/components/theme-toggle";
import { LoginPageImageStage } from "@/components/login-page-image-stage";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { login } from "@/lib/api";
import {
  clearRememberedLogin,
  getRememberedLogin,
  saveRememberedLogin,
} from "@/lib/remembered-login";
import { authSessionFromLoginResponse, setVerifiedAuthSession } from "@/lib/session";
import { useAppMeta } from "@/lib/use-app-meta";
import { resolveSiteIconSrc } from "@/lib/app-meta";
import { useRedirectIfAuthenticated } from "@/lib/use-auth-guard";
import { getDefaultRouteForSession } from "@/lib/auth-session";

const loginBackgroundClass =
  "bg-[#fff9fb] bg-[radial-gradient(rgba(20,86,240,0.12)_1px,transparent_1px),linear-gradient(145deg,#fff8fa_0%,#ffffff_48%,#f4f8ff_100%)] [background-position:0_0,center] [background-size:12px_12px,cover] dark:bg-[#090d16] dark:bg-[radial-gradient(rgba(96,165,250,0.16)_1px,transparent_1px),linear-gradient(145deg,#080b13_0%,#101827_52%,#070b12_100%)]";

export default function LoginPage() {
  const navigate = useNavigate();
  const appMeta = useAppMeta();
  const rememberedLogin = useRef(getRememberedLogin()).current;
  const [username, setUsername] = useState(rememberedLogin?.username || "");
  const [password, setPassword] = useState("");
  const [rememberAccount, setRememberAccount] = useState(Boolean(rememberedLogin));
  const [isSubmitting, setIsSubmitting] = useState(false);
  const { isCheckingAuth } = useRedirectIfAuthenticated();

  const finishAuth = async (data: Awaited<ReturnType<typeof login>>, message: string, redirectTo?: string) => {
    const session = authSessionFromLoginResponse(data);
    await setVerifiedAuthSession(session);
    toast.success(message);
    if (data.relay_onboarding_warnings?.length) {
      toast.warning("部分默认密钥未配置完成", {
        description: data.relay_onboarding_warnings.join("；"),
        duration: 12000,
      });
    }
    navigate(redirectTo || getDefaultRouteForSession(session), { replace: true });
  };

  const handleSubmit = async () => {
    const normalizedUsername = username.trim();
    if (!normalizedUsername) {
      toast.error("请输入用户名");
      return;
    }
    if (!password) {
      toast.error("请输入密码");
      return;
    }

    setIsSubmitting(true);
    try {
      const data = await login(normalizedUsername, password);
      if (rememberAccount) {
        saveRememberedLogin({ username: normalizedUsername });
      } else {
        clearRememberedLogin();
      }
      await finishAuth(data, "登录成功");
    } catch (error) {
      const message = error instanceof Error ? error.message : "登录失败";
      toast.error(message);
    } finally {
      setIsSubmitting(false);
    }
  };

  if (isCheckingAuth) {
    return (
      <div
        className={`${loginBackgroundClass} fixed inset-0 z-50 grid min-h-svh w-full place-items-center overflow-hidden px-4 py-6`}
      >
        <LoaderCircle className="size-5 animate-spin text-muted-foreground" />
      </div>
    );
  }

  return (
    <ScrollArea
      className={`${loginBackgroundClass} fixed inset-0 z-50 w-full font-sans`}
      viewportClassName="flex min-h-full items-center justify-center px-4 py-6 [align-items:safe_center] sm:px-6 lg:px-8"
      viewClass="w-full shrink-0"
    >
      <div className="fixed right-4 top-4 z-50 flex items-center gap-2 sm:right-6 sm:top-6">
        <ThemeToggle variant="outline" className="bg-card/90 backdrop-blur" />
      </div>

      <div className="relative z-10 mx-auto grid w-full max-w-[58rem] overflow-hidden rounded-2xl border border-border bg-card/95 ambient-shadow backdrop-blur transition-[min-height] duration-300 ease-[cubic-bezier(0.22,1,0.36,1)] motion-reduce:transition-none lg:min-h-[39rem] lg:grid-cols-[minmax(0,28rem)_minmax(0,1fr)]">
        <section className="flex min-h-[460px] flex-col justify-center px-6 py-8 sm:px-10 lg:px-12">
          <div className="flex flex-col gap-9 transition-[gap] duration-300 ease-[cubic-bezier(0.22,1,0.36,1)] motion-reduce:transition-none">
            <div className="flex items-center gap-3">
              <img
                src={resolveSiteIconSrc(appMeta.site_icon_url)}
                alt=""
                aria-hidden="true"
                className="size-11 shrink-0 rounded-xl soft-card-shadow"
              />
              <div className="grid min-w-0 leading-none">
                <div className="truncate text-sm font-semibold tracking-[-0.02em] text-foreground">
                  {appMeta.app_title || "云棉"}
                </div>
                <div className="truncate text-[10px] font-medium tracking-[0.28em] text-muted-foreground uppercase">
                  {appMeta.project_name && appMeta.project_name !== appMeta.app_title ? appMeta.project_name : "控制台"}
                </div>
              </div>
            </div>

            <div className="flex flex-col gap-4">
              <div className="inline-flex w-fit items-center gap-2 rounded-full border border-border bg-muted/60 px-3 py-1 text-[11px] font-semibold tracking-[0.2em] text-muted-foreground uppercase">
                <ShieldCheck className="size-3.5 text-brand" />
                安全访问
              </div>
              <div className="flex flex-col gap-2 transition-all duration-200 ease-[cubic-bezier(0.22,1,0.36,1)] motion-reduce:transition-none">
                <h1 className="text-[2.1rem] leading-[1.12] font-semibold tracking-[-0.04em] text-foreground sm:text-[2.5rem]">
                  欢迎回来
                </h1>
                <p className="max-w-[340px] text-sm leading-6 text-muted-foreground">
                  使用账号和密码进入 {appMeta.app_title || "云棉"} 控制台。
                </p>
              </div>
            </div>

            <form
              className="flex flex-col gap-5"
              onSubmit={(event) => {
                event.preventDefault();
                void handleSubmit();
              }}
            >
              <div className="flex flex-col gap-2">
                <label htmlFor="login-username" className="block text-sm font-semibold text-foreground">
                  用户名
                </label>
                <div className="relative">
                  <UserRound className="pointer-events-none absolute left-3.5 top-1/2 z-10 size-4 -translate-y-1/2 text-muted-foreground" />
                  <Input
                    id="login-username"
                    type="text"
                    autoComplete="username"
                    value={username}
                    onChange={(event) => setUsername(event.target.value)}
                    placeholder="请输入用户名"
                    className="h-12 pl-10"
                  />
                </div>
              </div>
              <div className="flex flex-col gap-2">
                <label htmlFor="login-password" className="block text-sm font-semibold text-foreground">
                  密码
                </label>
                <div className="relative">
                  <KeyRound className="pointer-events-none absolute left-3.5 top-1/2 z-10 size-4 -translate-y-1/2 text-muted-foreground" />
                  <Input
                    id="login-password"
                    type="password"
                    autoComplete="current-password"
                    value={password}
                    onChange={(event) => setPassword(event.target.value)}
                    placeholder="请输入密码"
                    className="h-12 pl-10"
                  />
                </div>
              </div>

              <label className="flex w-fit cursor-pointer items-center gap-2 text-sm text-muted-foreground">
                <Checkbox
                  checked={rememberAccount}
                  onCheckedChange={(checked) => {
                    const nextChecked = checked === true;
                    setRememberAccount(nextChecked);
                    if (!nextChecked) {
                      clearRememberedLogin();
                    }
                  }}
                  aria-label="记住账号"
                />
                <span>记住账号</span>
              </label>

              <div className="flex flex-col gap-3 pt-1">
                <Button
                  type="submit"
                  className="h-12 w-full"
                  disabled={isSubmitting}
                >
                  <span className="relative z-10 flex items-center gap-2 font-semibold tracking-[-0.01em] transition-opacity duration-150">
                    {isSubmitting ? (
                      <LoaderCircle className="size-4 animate-spin" />
                    ) : (
                      <ArrowRight className="size-4" />
                    )}
                    登录控制台
                  </span>
                </Button>
              </div>
            </form>
          </div>
        </section>

        <section className="relative hidden overflow-hidden border-l border-border bg-muted lg:flex">
          <div className="pointer-events-none absolute inset-0 bg-[linear-gradient(180deg,rgba(255,255,255,0.48),transparent_38%)] dark:bg-[linear-gradient(180deg,rgba(255,255,255,0.04),transparent_38%)]" />
          <div className="relative flex flex-1 items-stretch justify-stretch">
            <LoginPageImageStage
              src={appMeta.login_page_image_url}
              mode={appMeta.login_page_image_mode}
              zoom={appMeta.login_page_image_zoom}
              positionX={appMeta.login_page_image_position_x}
              positionY={appMeta.login_page_image_position_y}
              fillParent
              frameClassName="rounded-none"
              imageClassName="rounded-none"
            />
          </div>
        </section>
      </div>
    </ScrollArea>
  );
}
