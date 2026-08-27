import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  nextPreviewIndex,
  nextPreviewZoom,
  type PreviewImage,
} from "./image-preview";
import { useLocale } from "./LocaleContext";

export function ImageLightbox({
  images,
  index,
  onClose,
  onIndex,
}: {
  images: PreviewImage[];
  index: number;
  onClose: () => void;
  onIndex: (index: number) => void;
}) {
  const { t } = useLocale();
  const stageRef = useRef<HTMLDivElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<{ x: number; y: number; ox: number; oy: number } | null>(null);
  const [zoom, setZoom] = useState(1);
  const [offset, setOffset] = useState({ x: 0, y: 0 });
  const current = images[index];
  const many = images.length > 1;

  useEffect(() => {
    setZoom(1);
    setOffset({ x: 0, y: 0 });
    dragRef.current = null;
  }, [index, current?.id]);

  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const overflow = document.body.style.overflow;
    dialogRef.current?.focus();
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = overflow;
      previous?.focus?.();
    };
  }, []);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
        return;
      }
      if (!many) {
        return;
      }
      if (event.key === "ArrowLeft") {
        event.preventDefault();
        onIndex(nextPreviewIndex(index, images.length, -1));
      }
      if (event.key === "ArrowRight") {
        event.preventDefault();
        onIndex(nextPreviewIndex(index, images.length, 1));
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [images.length, index, many, onClose, onIndex]);

  useEffect(() => {
    const node = stageRef.current;
    if (!node) {
      return;
    }
    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      event.stopPropagation();
      setZoom((currentZoom) => {
        const next = nextPreviewZoom(currentZoom, event.deltaY);
        if (next <= 1) {
          setOffset({ x: 0, y: 0 });
        }
        return next;
      });
    };
    node.addEventListener("wheel", onWheel, { passive: false });
    return () => node.removeEventListener("wheel", onWheel);
  }, []);

  if (!current) {
    return null;
  }

  return createPortal(
    <div
      ref={dialogRef}
      className="image-lightbox"
      role="dialog"
      aria-modal="true"
      aria-label={t("preview.image")}
      tabIndex={-1}
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) {
          onClose();
        }
      }}
    >
      <div className="image-lightbox-bar">
        <p className="image-lightbox-caption">
          <span>{current.filename}</span>
          {many ? (
            <span>
              {t("preview.counter", { current: index + 1, total: images.length })}
            </span>
          ) : null}
        </p>
        <button type="button" className="image-lightbox-close" onClick={onClose} aria-label={t("preview.close")}>
          ×
        </button>
      </div>
      {many ? (
        <button
          type="button"
          className="image-lightbox-nav is-prev"
          aria-label={t("preview.previous")}
          onClick={() => onIndex(nextPreviewIndex(index, images.length, -1))}
        >
          ‹
        </button>
      ) : null}
      <div
        ref={stageRef}
        className={`image-lightbox-stage${zoom > 1 ? " is-zoomed" : ""}`}
        onMouseDown={(event) => {
          if (event.target === event.currentTarget) {
            onClose();
          }
        }}
      >
        <img
          src={current.src}
          alt={current.alt}
          draggable={false}
          style={{
            transform: `translate(${offset.x}px, ${offset.y}px) scale(${zoom})`,
          }}
          onDoubleClick={() => {
            setZoom((currentZoom) => (currentZoom > 1 ? 1 : 2));
            setOffset({ x: 0, y: 0 });
          }}
          onPointerDown={(event) => {
            if (zoom <= 1) {
              return;
            }
            event.currentTarget.setPointerCapture(event.pointerId);
            dragRef.current = {
              x: event.clientX,
              y: event.clientY,
              ox: offset.x,
              oy: offset.y,
            };
          }}
          onPointerMove={(event) => {
            const drag = dragRef.current;
            if (!drag) {
              return;
            }
            setOffset({
              x: drag.ox + (event.clientX - drag.x),
              y: drag.oy + (event.clientY - drag.y),
            });
          }}
          onPointerUp={() => {
            dragRef.current = null;
          }}
          onPointerCancel={() => {
            dragRef.current = null;
          }}
        />
      </div>
      {many ? (
        <button
          type="button"
          className="image-lightbox-nav is-next"
          aria-label={t("preview.next")}
          onClick={() => onIndex(nextPreviewIndex(index, images.length, 1))}
        >
          ›
        </button>
      ) : null}
    </div>,
    document.body,
  );
}
