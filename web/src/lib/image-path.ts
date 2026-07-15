export function getManagedImagePathFromUrl(value: string) {
  const text = value.trim();
  if (!text) {
    return "";
  }

  const extractFromPath = (pathname: string) => {
    const imagePrefix = "/images/";
    const imageIndex = pathname.indexOf(imagePrefix);
    if (imageIndex >= 0) {
      const encodedPath = pathname.slice(imageIndex + imagePrefix.length);
      if (!encodedPath) {
        return "";
      }
      try {
        return decodeURIComponent(encodedPath);
      } catch {
        return encodedPath;
      }
    }

    const thumbnailPrefix = "/image-thumbnails/";
    const thumbnailIndex = pathname.indexOf(thumbnailPrefix);
    if (thumbnailIndex < 0) {
      return "";
    }
    const encodedThumbnailPath = pathname.slice(thumbnailIndex + thumbnailPrefix.length);
    if (!encodedThumbnailPath) {
      return "";
    }
    const encodedPath = encodedThumbnailPath.replace(/\.jpg$/i, "");
    try {
      return decodeURIComponent(encodedPath);
    } catch {
      return encodedPath;
    }
  };

  try {
    const base = typeof window === "undefined" ? "http://localhost" : window.location.href;
    return extractFromPath(new URL(text, base).pathname);
  } catch {
    return extractFromPath(text);
  }
}

export function getManagedImageUrlFromPath(value: string) {
  const extractedPath = getManagedImagePathFromUrl(value);
  const normalizedPath = (extractedPath || value.trim())
    .replace(/\\/g, "/")
    .replace(/^\/+/, "");
  if (!normalizedPath) {
    return "";
  }

  const segments = normalizedPath.split("/");
  if (segments.some((segment) => !segment || segment === "." || segment === "..")) {
    return "";
  }
  return `/images/${segments.map((segment) => encodeURIComponent(segment)).join("/")}`;
}
