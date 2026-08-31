"use client";

import { useLoginPageImageState } from "@/components/use-login-page-image-state";
import { cn } from "@/lib/utils";
import {
  LOGIN_PAGE_IMAGE_DEFAULT_TRANSFORM,
  type LoginPageImageMode,
} from "@/lib/login-page-image-layout";

type LoginPageImageStageProps = {
  alt?: string;
  className?: string;
  fillParent?: boolean;
  frameClassName?: string;
  imageClassName?: string;
  mode?: LoginPageImageMode | string;
  positionX?: number;
  positionY?: number;
  src?: string;
  zoom?: number;
};

export function LoginPageImageStage({
  alt = "登录页展示图",
  className,
  fillParent = false,
  frameClassName,
  imageClassName,
  mode = "contain",
  positionX = LOGIN_PAGE_IMAGE_DEFAULT_TRANSFORM.positionX,
  positionY = LOGIN_PAGE_IMAGE_DEFAULT_TRANSFORM.positionY,
  src,
  zoom = LOGIN_PAGE_IMAGE_DEFAULT_TRANSFORM.zoom,
}: LoginPageImageStageProps) {
  const { currentSrc, frameRef, imageStyle, onImageError, onImageLoad } = useLoginPageImageState({
    mode,
    positionX,
    positionY,
    src,
    zoom,
  });

  return (
    <div
      className={cn(
        "flex w-full max-w-[30rem] items-center justify-center",
        fillParent ? "h-full max-w-none min-h-0" : undefined,
        className,
      )}
    >
      <div
        ref={frameRef}
        className={cn(
          "flex w-full items-center justify-center overflow-hidden rounded-[1.8rem]",
          fillParent ? "relative h-full w-full min-h-0 rounded-none" : "aspect-[16/10]",
          frameClassName,
        )}
      >
        <img
          src={currentSrc}
          alt={alt}
          className={cn("absolute top-0 left-0 max-w-none select-none", imageClassName)}
          draggable={false}
          onLoad={onImageLoad}
          onError={onImageError}
          style={imageStyle}
        />
      </div>
    </div>
  );
}
