"use client";

import { Avatar, AvatarFallback } from "@/components/ui/avatar";

import { ItemMedia } from "@/components/ui/item";
import { Separator } from "@/components/ui/separator";
import { TooltipHint, TooltipSideProvider } from "@/components/ui/tooltip";

import { ScrollArea } from "@/components/ui/scroll-area";

import { useEffect, useRef, useState } from "react";
import { SortableList, SortableItem } from "@/components/sortable-list";
import { LogOut, Menu, Pin, ShieldCheck, UserCircle2 } from "lucide-react";
import { NavigationIcon, type NavigationIconName } from "@/components/navigation-icon";
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

import { useAppMeta } from "@/lib/use-app-meta";
import { resolveSiteIconSrc } from "@/lib/app-meta";
import { readNavigationPins, writeNavigationPins } from "@/lib/navigation-pins";

const navItems: NavItem[] = [
  { href: "/studio", group: "creation", icon: "home", label: "创作台" },
  { href: "/canvas", group: "creation", icon: "canvas", label: "无限画布" },
  { href: "/workflows", group: "creation", icon: "workflow", label: "工作流" },
  { href: "/prompt-library", group: "resources", icon: "book", label: "提示词库" },
  { href: "/assets", group: "resources", icon: "folder", label: "我的素材" },
  { href: "/users", group: "management", icon: "users", label: "用户管理" },
  { href: "/rbac", group: "management", icon: "shield", label: "角色权限" },
  { href: "/logs", group: "management", icon: "logs", label: "日志管理" },
  { href: "/settings", group: "settings", icon: "settings", label: "系统设置" },
];
const profileNavItem = { href: "/profile", label: "个人设置" };
type NavItem = {
  href: string;
  group: "creation" | "resources" | "management" | "settings";
  label: string;
  icon: NavigationIconName;
};

function isActivePath(pathname: string, href: string) {
  return pathname === href || pathname.startsWith(`${href}/`);
}

function NavPill({ item, pathname, onPreloadRoute, compact = false, onNavigate }: {
  item: NavItem;
  compact?: boolean;
  onNavigate?: () => void;
  pathname: string;
  onPreloadRoute: (pathname: string) => void;
}) {
  const active = isActivePath(pathname, item.href);

  return (
    <Button asChild variant={active ? "secondary" : "ghost"} size={compact ? "icon-lg" : "default"} className={compact ? "size-9 shrink-0" : "min-h-11 w-full justify-start"}>
      <NavLink
        to={item.href}
        draggable={false}
        aria-label={item.label}
        data-tooltip={compact ? item.label : undefined}
        onClick={onNavigate}
        onPointerEnter={() => onPreloadRoute(item.href)}
        onFocus={() => onPreloadRoute(item.href)}
        onTouchStart={() => onPreloadRoute(item.href)}
      >
        <NavigationIcon name={item.icon} active={active} className={compact ? "size-5" : "size-4.5"} />
        <span className={compact ? "sr-only" : undefined}>{item.label}</span>
      </NavLink>
    </Button>
  );
}

function ManagementNavigationMenu({ items, pathname, pinnedPaths, onTogglePin, onPreloadRoute }: {
  items: NavItem[];
  pathname: string;
  pinnedPaths: readonly string[];
  onTogglePin: (path: string) => void;
  onPreloadRoute: (pathname: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const closeTimer = useRef<number | null>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);

  function cancelClose() {
    if (closeTimer.current !== null) window.clearTimeout(closeTimer.current);
    closeTimer.current = null;
  }

  function closeAfterPointerLeaves(event?: { pointerType: string }) {
    if (event && event.pointerType !== "mouse" && event.pointerType !== "pen") return;
    cancelClose();
    closeTimer.current = window.setTimeout(() => {
      closeTimer.current = null;
      setOpen(false);
    }, 180);
  }

  function openOnHover(event: { pointerType: string }) {
    if (event.pointerType !== "mouse" && event.pointerType !== "pen") return;
    cancelClose();
    setOpen(true);
  }

  function focusFirstLink() {
    requestAnimationFrame(() => contentRef.current?.querySelector<HTMLAnchorElement>("a")?.focus());
  }

  useEffect(() => () => {
    if (closeTimer.current !== null) window.clearTimeout(closeTimer.current);
  }, []);

  return <Popover open={open} onOpenChange={(value) => { cancelClose(); setOpen(value); }}>
    <PopoverTrigger asChild>
      <Button ref={triggerRef} variant="ghost" size="icon-lg" className="size-9" aria-label="管理中心"
        onPointerEnter={openOnHover} onPointerLeave={closeAfterPointerLeaves}
        onClick={(event) => { event.preventDefault(); cancelClose(); setOpen(true); }}
        onKeyDown={(event) => {
          if (!["ArrowRight", "ArrowDown", "Enter", " "].includes(event.key)) return;
          event.preventDefault();
          cancelClose();
          setOpen(true);
          focusFirstLink();
        }}
      ><NavigationIcon name="shield" active={items.some((item) => isActivePath(pathname, item.href))} className="size-5" /></Button>
    </PopoverTrigger>
    <PopoverContent ref={contentRef} side="right" align="start" sideOffset={8} aria-label="管理中心" className="w-64" data-management-navigation-content
      onPointerEnter={cancelClose} onPointerLeave={closeAfterPointerLeaves} onFocusCapture={cancelClose}
      onBlurCapture={(event) => {
        if (event.relatedTarget instanceof Node && (contentRef.current?.contains(event.relatedTarget) || triggerRef.current?.contains(event.relatedTarget))) return;
        closeAfterPointerLeaves();
      }}
    >
      <ScrollArea data-slot="popover-body" className="min-h-0 min-w-0 flex-1" contentClassName="flex flex-col gap-1 py-1">
        <nav aria-label="管理中心入口" className="flex flex-col gap-1">
          {items.map((item) => {
                      const pinned = pinnedPaths.includes(item.href);
            return <div key={item.href} className="flex min-w-0 items-center gap-1">
              <Button asChild variant={isActivePath(pathname, item.href) ? "secondary" : "ghost"} className="min-h-11 min-w-0 flex-1 justify-start">
                <NavLink to={item.href} onPointerEnter={() => onPreloadRoute(item.href)} onFocus={() => onPreloadRoute(item.href)} onClick={() => { cancelClose(); setOpen(false); }}><NavigationIcon name={item.icon} active={isActivePath(pathname, item.href)} className="size-4.5" /><span>{item.label}</span></NavLink>
              </Button>
              <TooltipHint content={`${pinned ? "取消置顶" : "置顶"}${item.label}`}><Button variant="ghost" size="icon-sm" aria-pressed={pinned} aria-label={`${pinned ? "取消置顶" : "置顶"}${item.label}`} onClick={() => onTogglePin(item.href)}><Pin className={pinned ? "fill-current" : undefined} /></Button></TooltipHint>
            </div>;
          })}
        </nav>
      </ScrollArea>
    </PopoverContent>
  </Popover>;
}

function NavigationRail({ items, pathname, scope, onPreloadRoute }: {
  items: NavItem[];
  pathname: string;
  scope: string;
  onPreloadRoute: (pathname: string) => void;
}) {
  const managementItems = items.filter((item) => item.group === "management");
  const [pinnedPaths, setPinnedPaths] = useState(() => readNavigationPins(scope, managementItems.map((item) => item.href)));

  function togglePin(path: string) {
    const next = pinnedPaths.includes(path) ? pinnedPaths.filter((item) => item !== path) : [path, ...pinnedPaths];
    reorderPins(next);
  }

  function reorderPins(next: string[]) {
    setPinnedPaths(next);
    writeNavigationPins(scope, next);
  }

  return <ScrollArea className="hidden w-full min-h-0 flex-1 md:flex" contentClassName="flex flex-col items-center gap-1.5 py-2 pl-3">
    <nav aria-label="主导航" className="flex flex-col items-center gap-1.5">
      {items.filter((item) => item.group === "creation" || item.group === "resources").map((item) => <NavPill key={item.href} item={item} pathname={pathname} onPreloadRoute={onPreloadRoute} compact />)}
      {managementItems.length ? <ManagementNavigationMenu items={managementItems} pathname={pathname} pinnedPaths={pinnedPaths} onTogglePin={togglePin} onPreloadRoute={onPreloadRoute} /> : null}
      <SortableList values={pinnedPaths} onReorder={reorderPins} aria-label="置顶导航排序" className="flex flex-col items-center gap-1.5">
        {(order) => order.flatMap((path) => managementItems.filter((item) => item.href === path)).map((item) => <SortableItem key={item.href} value={item.href} label={`${item.label}，拖动或按 Alt 加上下方向键排序`} handle={false}>
          <NavPill item={item} pathname={pathname} onPreloadRoute={onPreloadRoute} compact />
        </SortableItem>)}
      </SortableList>
    </nav>
  </ScrollArea>;
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
          variant="ghost"
          size="icon-lg"
          aria-label="账号菜单"
          className="size-9"
        >
          <Avatar className="size-7"><AvatarFallback>{initial}</AvatarFallback></Avatar>

        </Button>
      </PopoverTrigger>
      <PopoverContent
        align="end"
        sideOffset={8}
        className="w-[min(calc(100vw-2rem),280px)]"
      ><ScrollArea data-slot="popover-body" className="min-h-0 min-w-0 flex-1" contentClassName="grid gap-4 py-1">
        <div className="flex flex-col gap-1">
          <div className="px-3 py-2.5">
            <div className="flex min-w-0 items-center gap-2.5">
              <Avatar size="lg"><AvatarFallback>{initial}</AvatarFallback></Avatar>
              <div className="min-w-0 flex-1 space-y-1">
                <div className="flex min-w-0 items-center gap-2">
                  <div className="truncate text-sm font-semibold text-foreground">{displayName}</div>
                  <Badge
                    variant="secondary"
                    className="shrink-0"
                  >
                    {roleBadgeLabel}
                  </Badge>
                </div>
                <code className="block truncate font-mono text-xs text-muted-foreground">{accountID}</code>
              </div>
            </div>
          </div>

          <div className="grid grid-cols-1 gap-1">
            <Button asChild variant={profileActive ? "secondary" : "ghost"} className="h-11 w-full justify-start"><Link
              to={profileNavItem.href}
              onPointerEnter={() => onPreloadRoute(profileNavItem.href)}
              onFocus={() => onPreloadRoute(profileNavItem.href)}
              onTouchStart={() => onPreloadRoute(profileNavItem.href)}
              onClick={() => setOpen(false)}
            >
              <ItemMedia variant="icon" className="flex size-7 items-center justify-center">
                <UserCircle2 className="size-4" />
              </ItemMedia>
              <span className="flex-1 text-left">个人设置</span>
              {profileActive ? <ShieldCheck className="size-4 text-primary" /> : null}
            </Link></Button>
          </div>

          <Button variant="ghost"
            type="button"
            className="h-11 justify-start"
            onClick={() => {
              setOpen(false);
              void onLogout();
            }}
          >
            <ItemMedia variant="icon" className="flex size-7 items-center justify-center">
              <LogOut  />
            </ItemMedia>
            <span className="flex-1 text-left">退出登录</span>
          </Button>
        </div>
      </ScrollArea></PopoverContent>
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

  const [navigationOpen, setNavigationOpen] = useState(false);
  const [notificationSide, setNotificationSide] = useState<"right" | "bottom">("right");
  useEffect(() => {
    const query = window.matchMedia("(min-width: 768px)");
    const updateSide = () => setNotificationSide(query.matches ? "right" : "bottom");
    updateSide();
    query.addEventListener("change", updateSide);
    return () => query.removeEventListener("change", updateSide);
  }, []);


  if (pathname === "/login" || session === undefined || !session) {
    return null;
  }

  const visibleNavItems = navItems.filter((item) => canAccessPath(session, item.href));
  const settingsItem = visibleNavItems.find((item) => item.group === "settings");
  const roleLabel = session.role === "admin" ? "管理员" : session.roleName || "普通用户";
  const canAccessImageTasks = canAccessPath(session, "/studio");

  return (
    <TooltipSideProvider value="right">
    <aside data-app-navigation data-tooltip-side="right" aria-label="应用导航" className="relative z-40 flex shrink-0 items-center gap-2 px-3 py-2 md:h-full md:w-15 md:flex-col md:px-0 md:py-4">
      <div className="md:hidden"><TooltipHint content={appMeta.app_title}><Button asChild variant="ghost" size="icon-lg">
        <Link to={visibleNavItems[0]?.href || "/profile"} aria-label={appMeta.app_title}>
          <img src={resolveSiteIconSrc(appMeta.site_icon_url)} alt="" aria-hidden="true" className="size-7" />
        </Link>
      </Button></TooltipHint></div>
      <div className="md:hidden">
        <Popover open={navigationOpen} onOpenChange={setNavigationOpen}>
          <PopoverTrigger asChild><Button variant="ghost" size="icon" aria-label="打开导航菜单"><Menu /></Button></PopoverTrigger>
          <PopoverContent align="start" className="w-56">
            <ScrollArea data-slot="popover-body" className="min-h-0 min-w-0 flex-1" contentClassName="flex flex-col gap-1 py-1">
              <nav aria-label="移动端主导航" className="flex flex-col gap-1">
                {visibleNavItems.map((item) => <NavPill key={item.href} item={item} pathname={pathname} onPreloadRoute={onPreloadRoute} onNavigate={() => setNavigationOpen(false)} />)}
              </nav>
            </ScrollArea>
          </PopoverContent>
        </Popover>
      </div>
      <NavigationRail key={session.key} items={visibleNavItems} pathname={pathname} scope={session.key} onPreloadRoute={onPreloadRoute} />
      <div className="ml-auto flex shrink-0 items-center gap-1 md:ml-0 md:w-full md:flex-col md:gap-2">
        {settingsItem ? <div className="hidden md:block"><NavPill item={settingsItem} pathname={pathname} onPreloadRoute={onPreloadRoute} compact /></div> : null}
        <div aria-label="通知与任务" className="flex items-center gap-1 md:flex-col md:gap-2">
          {canAccessImageTasks ? <ImageTaskQueue key={`task-queue:${session.key}`} className="size-9" side={notificationSide} /> : null}
          <AnnouncementCenter key={`announcements:${session.key}`} sessionKey={session.key} className="size-9" side={notificationSide} />
        </div>
        <ThemeToggle className="size-9" />
        <Separator className="hidden md:block md:w-9" />
        <AccountMenu session={session} roleLabel={roleLabel} pathname={pathname} onPreloadRoute={onPreloadRoute} onLogout={handleLogout} />
      </div>
    </aside>
    </TooltipSideProvider>
  );
}
