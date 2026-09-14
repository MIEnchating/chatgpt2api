import { useEffect, useState } from "react";

import { COLOR_THEME_CHANGE_EVENT, getPreferredColorTheme } from "@/lib/theme";

export function useColorTheme() {
  const [theme, setTheme] = useState(getPreferredColorTheme);

  useEffect(() => {
    const syncTheme = () => setTheme(document.documentElement.classList.contains("dark") ? "dark" : "light");
    window.addEventListener(COLOR_THEME_CHANGE_EVENT, syncTheme);
    return () => window.removeEventListener(COLOR_THEME_CHANGE_EVENT, syncTheme);
  }, []);

  return theme;
}
