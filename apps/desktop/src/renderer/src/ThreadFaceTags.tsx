import type { ThreadFaceTag } from "./message-view";

/** Shared chip row for inbox list + thread header. */
export function ThreadFaceTags({ tags }: { tags: ThreadFaceTag[] }) {
  return (
    <>
      {tags.map((tag) => {
        if (tag.key === "channel") {
          return (
            <span
              key={tag.key}
              className={`channel-tag channel-${tag.channel}`}
            >
              {tag.label}
            </span>
          );
        }
        if (tag.key === "work") {
          return (
            <span
              key={tag.key}
              className={`kind-tag work-${tag.status}`}
              title={tag.label}
            >
              {tag.label}
            </span>
          );
        }
        return (
          <span key={tag.key} className="kind-tag" title={tag.label}>
            {tag.label}
          </span>
        );
      })}
    </>
  );
}
