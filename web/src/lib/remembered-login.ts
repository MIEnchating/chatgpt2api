const REMEMBERED_LOGIN_STORAGE_KEY = "chatgpt2api:remembered-login";

export type RememberedLogin = {
  username: string;
};

export function parseRememberedLogin(value: string | null): RememberedLogin | null {
  if (!value) {
    return null;
  }
  try {
    const parsed = JSON.parse(value) as Partial<RememberedLogin>;
    const username = typeof parsed.username === "string" ? parsed.username.trim() : "";
    return username ? { username } : null;
  } catch {
    return null;
  }
}

export function getRememberedLogin() {
  if (typeof window === "undefined") {
    return null;
  }
  const raw = window.localStorage.getItem(REMEMBERED_LOGIN_STORAGE_KEY);
  const remembered = parseRememberedLogin(raw);
  if (remembered) {
    window.localStorage.setItem(REMEMBERED_LOGIN_STORAGE_KEY, JSON.stringify(remembered));
  } else if (raw !== null) {
    window.localStorage.removeItem(REMEMBERED_LOGIN_STORAGE_KEY);
  }
  return remembered;
}

export function saveRememberedLogin(credentials: RememberedLogin) {
  if (typeof window === "undefined") {
    return;
  }
  window.localStorage.setItem(REMEMBERED_LOGIN_STORAGE_KEY, JSON.stringify(credentials));
}

export function clearRememberedLogin() {
  if (typeof window === "undefined") {
    return;
  }
  window.localStorage.removeItem(REMEMBERED_LOGIN_STORAGE_KEY);
}
