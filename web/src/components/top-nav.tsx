"use client";

import { useEffect, useState } from "react";
import { ChevronDown, LogOut, ShieldCheck, UserCircle2 } from "lucide-react";
import { motion, useReducedMotion, type Transition } from "motion/react";
import { Link, NavLink, useLocation, useNavigate } from "react-router-dom";

import { ImageTaskQueue } from "@/components/image-task-queue";
import { AnnouncementCenter } from "@/components/announcement-center";
import { ThemeToggle } from "@/components/theme-toggle";
import {
  clearVerifiedAuthSession,
  displaySubjectId,
  getCachedAuthSession,
  getVerifiedAuthSession,
} from "@/lib/session";
import { AUTH_SESSION_CHANGE_EVENT, canAccessPath, type StoredAuthSession } from "@/lib/auth-session";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { logout } from "@/lib/api";
import { cn } from "@/lib/utils";
import { useAppMeta } from "@/lib/use-app-meta";
import { resolveSiteIconSrc } from "@/lib/app-meta";

const navItems = [
  { href: "/studio", label: "创作台" },
  { href: "/canvas", label: "无限画布" },
  { href: "/workflows", label: "工作流" },
  { href: "/prompt-library", label: "提示词库" },
  { href: "/assets", label: "我的素材" },
  { href: "/users", label: "用户管理" },
  { href: "/rbac", label: "角色权限" },
  { href: "/logs", label: "日志管理" },
  { href: "/settings", label: "设置" },
];
const profileNavItem = { href: "/profile", label: "个人中心" };
const NAV_ACTIVE_LAYOUT_ID = "top-nav-active-pill";
const navActiveTransition: Transition = {
  type: "spring",
  stiffness: 520,
  damping: 42,
  mass: 0.7,
};
const reducedNavActiveTransition: Transition = {
  duration: 0.01,
};

type NavItem = {
  href: string;
  label: string;
};

function isActivePath(pathname: string, href: string) {
  return pathname === href || pathname.startsWith(`${href}/`);
}

function NavPill({ item, pathname, onPreloadRoute }: {
  item: NavItem;
  pathname: string;
  onPreloadRoute: (pathname: string) => void;
}) {
  const active = isActivePath(pathname, item.href);
  const prefersReducedMotion = useReducedMotion();

  return (
    <NavLink
      to={item.href}
      onPointerEnter={() => onPreloadRoute(item.href)}
      onFocus={() => onPreloadRoute(item.href)}
      onTouchStart={() => onPreloadRoute(item.href)}
      className={() =>
        cn(
          "relative isolate shrink-0 whitespace-nowrap rounded-lg px-3 py-2 text-[13px] font-medium transition-colors sm:text-sm",
          active
            ? "text-accent-foreground"
            : "text-muted-foreground hover:bg-accent hover:text-accent-foreground",
        )
      }
    >
      {active ? (
        <motion.span
          layoutId={NAV_ACTIVE_LAYOUT_ID}
          transition={prefersReducedMotion ? reducedNavActiveTransition : navActiveTransition}
          className="absolute inset-0 -z-10 rounded-lg bg-accent"
        />
      ) : null}
      <motion.span
        animate={{ scale: active && !prefersReducedMotion ? 1.03 : 1 }}
        transition={prefersReducedMotion ? reducedNavActiveTransition : { duration: 0.16, ease: [0.22, 1, 0.36, 1] }}
        className="relative z-10 block"
      >
        {item.label}
      </motion.span>
    </NavLink>
  );
}

function AccountMenu({
  session,
  roleLabel,
  pathname,
  onPreloadRoute,
  onLogout,
}: {
  session: StoredAuthSession;
  roleLabel: string;
  pathname: string;
  onPreloadRoute: (pathname: string) => void;
  onLogout: () => Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const displayName = session.name || roleLabel;
  const initial = (displayName.trim() || "U").slice(0, 1).toUpperCase();
  const profileActive = isActivePath(pathname, profileNavItem.href);
  const accountID = displaySubjectId(session.subjectId, session.provider);
  const roleBadgeLabel = session.role === "admin" ? "管理权限" : roleLabel;

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="outline"
          className={cn(
            "h-9 rounded-lg px-2.5 shadow-none",
            profileActive ? "border-brand/30 bg-brand/10 text-brand" : "",
          )}
          aria-label="账号菜单"
        >
          <span className="flex size-6 shrink-0 items-center justify-center rounded-full bg-primary text-xs font-semibold text-primary-foreground">
            {initial}
          </span>
          <span className="hidden max-w-[120px] truncate lg:inline">{displayName}</span>
          <ChevronDown />
        </Button>
      </PopoverTrigger>
      <PopoverContent
        align="end"
        sideOffset={8}
        className="w-[min(calc(100vw-2rem),280px)] p-1.5"
      >
        <div className="flex flex-col gap-1">
          <div className="rounded-xl bg-muted/55 px-3 py-2.5">
            <div className="flex min-w-0 items-center gap-2.5">
              <span className="flex size-10 shrink-0 items-center justify-center rounded-full bg-primary text-sm font-semibold text-primary-foreground">
                {initial}
              </span>
              <div className="min-w-0 flex-1 space-y-1">
                <div className="flex min-w-0 items-center gap-2">
                  <div className="truncate text-sm font-semibold text-foreground">{displayName}</div>
                  <Badge
                    variant={session.role === "admin" ? "violet" : "secondary"}
                    className="shrink-0 rounded-md px-1.5 py-0 text-[11px] leading-5"
                  >
                    {roleBadgeLabel}
                  </Badge>
                </div>
                <code className="block truncate font-mono text-xs text-muted-foreground">{accountID}</code>
              </div>
            </div>
          </div>

          <div className="grid grid-cols-1 gap-1">
            <Link
              to={profileNavItem.href}
              onPointerEnter={() => onPreloadRoute(profileNavItem.href)}
              onFocus={() => onPreloadRoute(profileNavItem.href)}
              onTouchStart={() => onPreloadRoute(profileNavItem.href)}
              className={cn(
                "flex h-9 items-center gap-2 rounded-xl px-2.5 text-sm font-medium transition hover:bg-accent hover:text-accent-foreground",
                profileActive ? "bg-brand/10 text-brand" : "text-foreground",
              )}
              onClick={() => setOpen(false)}
            >
              <span className="flex size-7 items-center justify-center rounded-lg bg-muted text-muted-foreground">
                <UserCircle2 className="size-4" />
              </span>
              <span className="flex-1 text-left">个人中心</span>
              {profileActive ? <ShieldCheck className="size-4 text-brand" /> : null}
            </Link>
          </div>

          <button
            type="button"
            className="flex h-9 items-center gap-2 rounded-xl px-2.5 text-sm font-medium text-rose-600 transition hover:bg-rose-50 hover:text-rose-700 dark:text-rose-400 dark:hover:bg-rose-950/30 dark:hover:text-rose-300"
            onClick={() => {
              setOpen(false);
              void onLogout();
            }}
          >
            <span className="flex size-7 items-center justify-center rounded-lg bg-rose-50 text-rose-600 dark:bg-rose-950/40 dark:text-rose-300">
              <LogOut className="size-4" />
            </span>
            <span className="flex-1 text-left">退出登录</span>
          </button>
        </div>
      </PopoverContent>
    </Popover>
  );
}

export function TopNav({ onPreloadRoute }: { onPreloadRoute: (pathname: string) => void }) {
  const location = useLocation();
  const navigate = useNavigate();
  const appMeta = useAppMeta();
  const pathname = location.pathname.replace(/\/+$/, "") || "/";
  const [session, setSession] = useState<StoredAuthSession | null | undefined>(() => getCachedAuthSession());

  useEffect(() => {
    let active = true;

    const load = async () => {
      if (pathname === "/login") {
        if (!active) {
          return;
        }
        setSession(null);
        return;
      }

      const storedSession = await getVerifiedAuthSession();
      if (!active) {
        return;
      }
      setSession(storedSession);
    };

    void load().catch(() => {
      // The route guard owns verification error feedback and retry handling.
    });
    return () => {
      active = false;
    };
  }, [pathname]);

  useEffect(() => {
    let active = true;
    const handleSessionChange = () => {
      const cachedSession = getCachedAuthSession();
      setSession(cachedSession);
      if (cachedSession !== undefined) {
        return;
      }
      void getVerifiedAuthSession()
        .then((verifiedSession) => {
          if (active) {
            setSession(verifiedSession);
          }
        })
        .catch(() => {
          // The route guard owns verification error feedback and retry handling.
        });
    };
    window.addEventListener(AUTH_SESSION_CHANGE_EVENT, handleSessionChange);
    return () => {
      active = false;
      window.removeEventListener(AUTH_SESSION_CHANGE_EVENT, handleSessionChange);
    };
  }, []);

  const handleLogout = async () => {
    try {
      await logout();
    } catch {
      // Local logout should still complete if the server session cookie is already gone.
    }
    await clearVerifiedAuthSession();
    navigate("/login", { replace: true });
  };

  if (pathname === "/login" || session === undefined || !session) {
    return null;
  }

  const visibleNavItems = navItems.filter((item) => canAccessPath(session, item.href));
  const roleLabel = session.role === "admin" ? "管理员" : session.roleName || "普通用户";
  const canAccessImageTasks = canAccessPath(session, "/studio");

  return (
    <header className="relative z-40 shrink-0 rounded-xl border border-border bg-card/95 soft-card-shadow backdrop-blur">
      <div className="grid min-h-14 grid-cols-[minmax(0,1fr)_auto] items-center gap-x-2 gap-y-2 px-3 py-2 xl:grid-cols-[auto_minmax(0,1fr)_auto] xl:gap-4 xl:px-4">
        <div className="flex min-w-0 items-center gap-2 xl:col-start-1 xl:justify-self-start">
          <div className="flex h-9 max-w-[190px] items-center gap-2 rounded-xl px-1.5 pr-2 text-[15px] font-semibold text-foreground sm:max-w-none">
            <img
              src={resolveSiteIconSrc(appMeta.site_icon_url)}
              alt=""
              aria-hidden="true"
              className="size-7 shrink-0 rounded-lg"
            />
            <span className="truncate">{appMeta.app_title}</span>
          </div>
        </div>
        <nav
          aria-label="主导航"
          className="hide-scrollbar col-span-2 row-start-2 -mx-1 flex min-w-0 gap-1 overflow-x-auto overscroll-x-contain px-1 pb-0.5 scroll-px-1 touch-pan-x [-webkit-overflow-scrolling:touch] xl:col-span-1 xl:col-start-2 xl:row-start-1 xl:mx-0 xl:w-full xl:justify-self-stretch xl:gap-1.5 xl:px-1 xl:py-1 [@media(min-width:1280px)]:[justify-content:safe_center]"
        >
          {visibleNavItems.map((item) => (
            <NavPill key={item.href} item={item} pathname={pathname} onPreloadRoute={onPreloadRoute} />
          ))}
        </nav>
        <div className="col-start-2 row-start-1 flex items-center justify-end gap-1 xl:col-start-3 xl:gap-1.5 xl:justify-self-end">
          {canAccessImageTasks ? <ImageTaskQueue key={`task-queue:${session.key}`} className="size-8 px-0 lg:h-9 lg:w-auto lg:px-3" /> : null}
          <AnnouncementCenter key={`announcements:${session.key}`} sessionKey={session.key} />
          <ThemeToggle />
          <AccountMenu
            session={session}
            roleLabel={roleLabel}
            pathname={pathname}
            onPreloadRoute={onPreloadRoute}
            onLogout={handleLogout}
          />
        </div>
      </div>
    </header>
  );
}
