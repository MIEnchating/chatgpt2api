"use client";

import { useEffect, useState } from "react";
import { ChevronDown, LogOut, MoonStar, ShieldCheck, Sun, UserCircle2 } from "lucide-react";
import { motion, useReducedMotion, type Transition } from "motion/react";
import { Link, NavLink, useLocation, useNavigate } from "react-router-dom";

import { AnnouncementNotifications } from "@/components/announcement-banner";
import { ImageTaskQueue } from "@/components/image-task-queue";
import {
  AUTH_SESSION_CHANGE_EVENT,
  clearVerifiedAuthSession,
  getCachedAuthSession,
  getVerifiedAuthSession,
} from "@/lib/session";
import { canAccessPath, type StoredAuthSession } from "@/store/auth";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { logout } from "@/lib/api";
import { cn } from "@/lib/utils";
import {
  applyColorTheme,
  getPreferredColorTheme,
  saveColorTheme,
  type ColorTheme,
} from "@/lib/theme";

const navItems = [
  { href: "/image", label: "创作台" },
  { href: "/image-manager", label: "图片库" },
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

function ThemeToggleButton({
  theme,
  onToggle,
  className,
}: {
  theme: ColorTheme;
  onToggle: (button: HTMLButtonElement) => void;
  className?: string;
}) {
  const dark = theme === "dark";

  return (
    <Button
      type="button"
      variant="ghost"
      size="icon"
      className={cn("relative size-8 rounded-full", className)}
      onClick={(event) => onToggle(event.currentTarget)}
      aria-label={dark ? "切换到浅色模式" : "切换到深色模式"}
      title={dark ? "浅色模式" : "深色模式"}
    >
      <Sun className="scale-100 rotate-0 transition-all dark:scale-0 dark:-rotate-90" />
      <MoonStar className="absolute scale-0 rotate-90 transition-all dark:scale-100 dark:rotate-0" />
      <span className="sr-only">切换界面主题</span>
    </Button>
  );
}

type NavItem = {
  href: string;
  label: string;
};

function isActivePath(pathname: string, href: string) {
  return pathname === href || pathname.startsWith(`${href}/`);
}

function NavPill({ item, pathname }: { item: NavItem; pathname: string }) {
  const active = isActivePath(pathname, item.href);
  const prefersReducedMotion = useReducedMotion();

  return (
    <NavLink
      to={item.href}
      className={() =>
        cn(
          "relative isolate shrink-0 whitespace-nowrap rounded-full px-3 py-1.5 text-[13px] font-medium transition-colors sm:text-sm",
          active
            ? "text-[#18181b] dark:text-accent-foreground"
            : "text-[#45515e] hover:bg-black/[0.05] hover:text-[#18181b] dark:text-muted-foreground dark:hover:bg-accent dark:hover:text-accent-foreground",
        )
      }
    >
      {active ? (
        <motion.span
          layoutId={NAV_ACTIVE_LAYOUT_ID}
          transition={prefersReducedMotion ? reducedNavActiveTransition : navActiveTransition}
          className="absolute inset-0 -z-10 rounded-full bg-black/[0.06] shadow-[inset_0_0_0_1px_rgba(20,86,240,0.08)] dark:bg-accent"
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
  onLogout,
}: {
  session: StoredAuthSession;
  roleLabel: string;
  pathname: string;
  onLogout: () => Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const displayName = session.name || roleLabel;
  const initial = (displayName.trim() || "U").slice(0, 1).toUpperCase();
  const profileActive = isActivePath(pathname, profileNavItem.href);
  const accountID = session.subjectId || session.role;
  const roleBadgeLabel = session.role === "admin" ? "管理权限" : roleLabel;

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="outline"
          className={cn(
            "h-9 rounded-full px-2.5 shadow-none",
            profileActive ? "border-[#1456f0]/30 bg-[#edf4ff] text-[#1456f0] dark:bg-sky-950/30 dark:text-sky-300" : "",
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
        className="w-[min(calc(100vw-2rem),260px)] rounded-2xl border-border bg-card p-1.5 text-card-foreground shadow-[0_18px_48px_-26px_rgba(15,23,42,0.5)] dark:border-border dark:bg-card"
      >
        <div className="flex flex-col gap-1">
          <div className="rounded-xl bg-muted/55 px-3 py-2.5">
            <div className="flex min-w-0 items-center gap-2.5">
              <span className="flex size-10 shrink-0 items-center justify-center rounded-full bg-[#181d25] text-sm font-semibold text-white shadow-[0_8px_18px_-12px_rgba(15,23,42,0.65)] dark:bg-primary dark:text-primary-foreground">
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
              className={cn(
                "flex h-9 items-center gap-2 rounded-xl px-2.5 text-sm font-medium transition hover:bg-accent hover:text-accent-foreground",
                profileActive ? "bg-[#edf4ff] text-[#1456f0] dark:bg-sky-950/30 dark:text-sky-300" : "text-foreground",
              )}
              onClick={() => setOpen(false)}
            >
              <span className="flex size-7 items-center justify-center rounded-lg bg-muted text-muted-foreground">
                <UserCircle2 className="size-4" />
              </span>
              <span className="flex-1 text-left">个人中心</span>
              {profileActive ? <ShieldCheck className="size-4 text-[#1456f0] dark:text-sky-300" /> : null}
            </Link>
          </div>

          <button
            type="button"
            className="flex h-9 items-center gap-2 rounded-xl px-2.5 text-sm font-medium text-rose-600 transition hover:bg-rose-50 hover:text-rose-700 dark:text-rose-400 dark:hover:bg-rose-950/30"
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

export function TopNav() {
  const location = useLocation();
  const navigate = useNavigate();
  const pathname = location.pathname.replace(/\/+$/, "") || "/";
  const [session, setSession] = useState<StoredAuthSession | null | undefined>(() => getCachedAuthSession());
  const [theme, setTheme] = useState<ColorTheme>(() => getPreferredColorTheme());

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

    void load();
    return () => {
      active = false;
    };
  }, [pathname]);

  useEffect(() => {
    const handleSessionChange = () => {
      setSession(getCachedAuthSession() ?? null);
    };
    window.addEventListener(AUTH_SESSION_CHANGE_EVENT, handleSessionChange);
    return () => {
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

  const handleThemeToggle = (button: HTMLButtonElement) => {
    const nextTheme = theme === "dark" ? "light" : "dark";
    const rect = button.getBoundingClientRect();
    applyColorTheme(
      nextTheme,
      {
        force: true,
        origin: {
          x: rect.left + rect.width / 2,
          y: rect.top + rect.height / 2,
        },
      },
    );
    saveColorTheme(nextTheme);
    setTheme(nextTheme);
  };

  if (pathname === "/login" || session === undefined || !session) {
    return null;
  }

  const visibleNavItems = navItems.filter((item) => canAccessPath(session, item.href));
  const roleLabel = session.role === "admin" ? "管理员" : session.roleName || "普通用户";
  const canAccessImageTasks = canAccessPath(session, "/image");

  return (
    <header className="sticky top-3 z-40 rounded-2xl border border-border bg-card/92 shadow-[0_12px_36px_-28px_rgba(15,23,42,0.55)] backdrop-blur dark:border-border dark:bg-card/92">
      <div className="flex min-h-14 flex-col gap-2 px-3 py-2 lg:flex-row lg:items-center lg:justify-between lg:gap-4 lg:px-4">
        <div className="flex min-w-0 items-center justify-between gap-2 lg:justify-start">
          <div className="flex h-9 max-w-[190px] items-center gap-2 rounded-xl px-1.5 pr-2 text-[15px] font-semibold text-[#18181b] sm:max-w-none dark:text-foreground">
            <img
              src="/logo-mark.svg"
              alt=""
              aria-hidden="true"
              className="size-7 rounded-[10px] shadow-[0_4px_10px_rgba(184,90,127,0.16)]"
            />
            <span className="truncate">chatgpt2api</span>
          </div>
          <div className="ml-auto flex shrink-0 items-center gap-1 lg:hidden">
            {canAccessImageTasks ? <ImageTaskQueue className="size-8 px-0" /> : null}
            <AnnouncementNotifications target="image" className="size-8" />
            <ThemeToggleButton theme={theme} onToggle={handleThemeToggle} />
            <AccountMenu
              session={session}
              roleLabel={roleLabel}
              pathname={pathname}
              onLogout={handleLogout}
            />
          </div>
        </div>
        <nav
          aria-label="主导航"
          className="hide-scrollbar -mx-1 flex min-w-0 gap-1 overflow-x-auto overscroll-x-contain px-1 pb-0.5 scroll-px-1 touch-pan-x [-webkit-overflow-scrolling:touch] lg:mx-0 lg:flex-1 lg:justify-center lg:gap-1.5 lg:px-0 lg:pb-0"
        >
          {visibleNavItems.map((item) => (
            <NavPill key={item.href} item={item} pathname={pathname} />
          ))}
        </nav>
        <div className="hidden items-center justify-end gap-1.5 lg:flex">
          {canAccessImageTasks ? <ImageTaskQueue /> : null}
          <AnnouncementNotifications target="image" className="size-8" />
          <ThemeToggleButton theme={theme} onToggle={handleThemeToggle} />
          <AccountMenu
            session={session}
            roleLabel={roleLabel}
            pathname={pathname}
            onLogout={handleLogout}
          />
        </div>
      </div>
    </header>
  );
}
