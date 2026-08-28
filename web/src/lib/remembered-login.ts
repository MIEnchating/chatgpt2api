const REMEMBERED_LOGIN_STORAGE_KEY = "chatgpt2api:remembered-login";

export type RememberedLogin = {
  username: string;
  password: string;
};

export function parseRememberedLogin(value: string | null): RememberedLogin | null {
  if (!value) {
    return null;
  }
  try {
    const parsed = JSON.parse(value) as Partial<RememberedLogin>;
    const username = typeof parsed.username === "string" ? parsed.username.trim() : "";
    const password = typeof parsed.password === "string" ? parsed.password : "";
    return username && password ? { username, password } : null;
  } catch {
    return null;
  }
}

export function getRememberedLogin() {
  if (typeof window === "undefined") {
    return null;
  }
  return parseRememberedLogin(window.localStorage.getItem(REMEMBERED_LOGIN_STORAGE_KEY));
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
