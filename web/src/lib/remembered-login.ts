const REMEMBERED_LOGIN_STORAGE_KEY = "chatgpt2api:remembered-login";

export type RememberedLogin = {
  username: string;
};

function getBrowserLocalStorage() {
  if (typeof window === "undefined") {
    return null;
  }
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

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
  const storage = getBrowserLocalStorage();
  if (!storage) {
    return null;
  }
  let raw: string | null;
  try {
    raw = storage.getItem(REMEMBERED_LOGIN_STORAGE_KEY);
  } catch {
    return null;
  }
  const remembered = parseRememberedLogin(raw);
  try {
    if (remembered) {
      storage.setItem(REMEMBERED_LOGIN_STORAGE_KEY, JSON.stringify(remembered));
    } else if (raw !== null) {
      storage.removeItem(REMEMBERED_LOGIN_STORAGE_KEY);
    }
  } catch {
    // Remembering an account must not block login when browser storage is unavailable.
  }
  return remembered;
}

export function saveRememberedLogin(credentials: RememberedLogin) {
  const storage = getBrowserLocalStorage();
  if (!storage) {
    return;
  }
  const remembered = parseRememberedLogin(JSON.stringify(credentials));
  if (!remembered) return;
  try {
    storage.setItem(REMEMBERED_LOGIN_STORAGE_KEY, JSON.stringify(remembered));
  } catch {
    // Remembering an account is optional.
  }
}

export function clearRememberedLogin() {
  const storage = getBrowserLocalStorage();
  if (!storage) {
    return;
  }
  try {
    storage.removeItem(REMEMBERED_LOGIN_STORAGE_KEY);
  } catch {
    // Clearing an optional preference must not block authentication.
  }
}
