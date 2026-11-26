import { useEffect, useRef, useState, type ReactNode, type SyntheticEvent } from "react";
import { inlineBytesPlay, inlineMediaKind, readAttachmentObjectUrl } from "./attachment-actions";
import type { InboxAttachment } from "./types";

export function InlineMedia({
  eventId,
  file,
  pending,
  fallback,
  poster,
  label,
}: {
  eventId: string;
  file: InboxAttachment;
  pending: ReactNode;
  fallback: ReactNode;
  poster?: string;
  label?: string;
}) {
  const kind = inlineMediaKind(file);
  const [src, setSrc] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const [audible, setAudible] = useState(false);
  const wait = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(wait.current), []);
  useEffect(() => {
    if (!kind) return undefined;
    let url = "";
    let alive = true;
    setFailed(false);
    setAudible(false);
    setSrc(null);
    readAttachmentObjectUrl(eventId, file)
      .then((next) => {
        if (!alive) {
          URL.revokeObjectURL(next.url);
          return;
        }
        if (!inlineBytesPlay(kind, next.mediaType)) {
          URL.revokeObjectURL(next.url);
          setFailed(true);
          return;
        }
        url = next.url;
        setSrc(next.url);
      })
      .catch(() => {
        if (alive) setFailed(true);
      });
    return () => {
      alive = false;
      window.clearTimeout(wait.current);
      if (url) URL.revokeObjectURL(url);
    };
  }, [eventId, file.part_index, file.content_hash, file.media_type, file.filename, kind]);
  function hear(event: SyntheticEvent<HTMLAudioElement>) {
    window.clearTimeout(wait.current);
    const node = event.currentTarget;
    const accept = () => {
      const duration = node.duration;
      if (Number.isFinite(duration) && duration > 0) setAudible(true);
      else setFailed(true);
    };
    if (Number.isFinite(node.duration) && node.duration > 0) {
      setAudible(true);
      return;
    }
    wait.current = window.setTimeout(accept, 300);
  }
  if (!kind || failed) return <>{fallback}</>;
  if (!src) return <>{pending}</>;
  if (kind === "audio" && !audible) {
    return (
      <>
        {pending}
        <audio
          className="msg-audio-probe"
          preload="metadata"
          src={src}
          onLoadedMetadata={hear}
          onDurationChange={hear}
          onError={() => setFailed(true)}
        />
      </>
    );
  }
  return kind === "video"
    ? (
      <video
        className="msg-video"
        controls
        preload="metadata"
        poster={poster}
        aria-label={label}
        src={src}
        onError={() => setFailed(true)}
      />
    )
    : <audio className="msg-audio" controls preload="metadata" aria-label={label} src={src} />;
}
