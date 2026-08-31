"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties, SyntheticEvent } from "react";

import { DEFAULT_LOGIN_PAGE_IMAGE, resolveLoginPageImageSrc } from "@/lib/app-meta";
import {
  getLoginPageImageLayout,
  normalizeLoginPageImageMode,
  normalizeLoginPageImageTransform,
  type LoginPageImageMode,
} from "@/lib/login-page-image-layout";

type LoginPageImageStateOptions = {
  mode: LoginPageImageMode | string;
  positionX: number;
  positionY: number;
  src?: string;
  zoom: number;
};

export function useLoginPageImageState({ mode, positionX, positionY, src, zoom }: LoginPageImageStateOptions) {
  const frameRef = useRef<HTMLDivElement | null>(null);
  const [failedSrc, setFailedSrc] = useState("");
  const [imageSize, setImageSize] = useState({ width: 0, height: 0 });
  const [frameSize, setFrameSize] = useState({ width: 0, height: 0 });
  const resolvedMode = normalizeLoginPageImageMode(mode);
  const resolvedSrc = resolveLoginPageImageSrc(src);
  const fallbackSrc = resolveLoginPageImageSrc(DEFAULT_LOGIN_PAGE_IMAGE);
  const currentSrc = failedSrc === resolvedSrc ? fallbackSrc : resolvedSrc;
  const transform = useMemo(
    () => normalizeLoginPageImageTransform({ zoom, positionX, positionY }),
    [positionX, positionY, zoom],
  );
  const imageLayout = useMemo(
    () =>
      getLoginPageImageLayout({
        frameWidth: frameSize.width,
        frameHeight: frameSize.height,
        imageWidth: imageSize.width,
        imageHeight: imageSize.height,
        mode: resolvedMode,
        zoom: transform.zoom,
        positionX: transform.positionX,
        positionY: transform.positionY,
      }),
    [
      frameSize.height,
      frameSize.width,
      imageSize.height,
      imageSize.width,
      resolvedMode,
      transform.positionX,
      transform.positionY,
      transform.zoom,
    ],
  );

  useEffect(() => {
    const frame = frameRef.current;
    if (!frame) return undefined;

    const updateFrameSize = () => {
      const nextWidth = frame.clientWidth;
      const nextHeight = frame.clientHeight;
      setFrameSize((current) =>
        current.width === nextWidth && current.height === nextHeight
          ? current
          : { width: nextWidth, height: nextHeight },
      );
    };

    updateFrameSize();
    const observer = new ResizeObserver(updateFrameSize);
    observer.observe(frame);
    return () => observer.disconnect();
  }, []);

  const onImageLoad = useCallback((event: SyntheticEvent<HTMLImageElement>) => {
    const target = event.currentTarget;
    const nextImageSize = { width: target.naturalWidth, height: target.naturalHeight };
    setImageSize((current) =>
      current.width === nextImageSize.width && current.height === nextImageSize.height ? current : nextImageSize,
    );
  }, []);

  const onImageError = useCallback((event: SyntheticEvent<HTMLImageElement>) => {
    if (event.currentTarget.src !== fallbackSrc) {
      event.currentTarget.src = fallbackSrc;
      setFailedSrc(resolvedSrc);
    }
  }, [fallbackSrc, resolvedSrc]);

  const imageStyle: CSSProperties = imageLayout
    ? {
        width: `${imageLayout.width}px`,
        height: `${imageLayout.height}px`,
        transform: `translate(${imageLayout.x}px, ${imageLayout.y}px)`,
        transformOrigin: "top left",
      }
    : {
        inset: 0,
        width: "100%",
        height: "100%",
        objectFit: resolvedMode === "fill" ? "fill" : resolvedMode,
        objectPosition: `${transform.positionX}% ${transform.positionY}%`,
        transform: `scale(${transform.zoom})`,
        transformOrigin: "center center",
      };

  return {
    currentSrc,
    frameRef,
    frameSize,
    imageLayout,
    imageSize,
    imageStyle,
    onImageError,
    onImageLoad,
    resolvedMode,
    transform,
  };
}
