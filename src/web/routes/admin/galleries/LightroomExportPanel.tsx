import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "../../../lib/api.ts";
import type { LightroomListResponse } from "../../../lib/types.ts";

export function LightroomExportPanel(props: { galleryId: string }) {
  const [copied, setCopied] = useState(false);

  const list = useQuery({
    queryKey: ["lightroom-list", props.galleryId],
    queryFn: () =>
      api.get<LightroomListResponse>(`/api/admin/galleries/${props.galleryId}/lightroom-list`),
  });

  async function handleCopy(text: string) {
    await navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }

  return (
    <div className="rounded-2xl border border-ink-100 bg-white p-6 shadow-sm">
      <div className="flex items-center justify-between gap-4">
        <div>
          <h2 className="text-sm font-semibold text-ink-900">Lightroom picks</h2>
          <p className="mt-0.5 text-xs text-ink-400">
            Paste into Lightroom Classic's Library Filter (Text search → Filename → set match to Any)
            to select every pick at once.
          </p>
        </div>
        {list.data && list.data.count > 0 && (
          <span className="shrink-0 rounded-full bg-ink-100 px-2.5 py-1 text-xs font-medium text-ink-700">
            {list.data.count} {list.data.count === 1 ? "favorite" : "favorites"}
          </span>
        )}
      </div>

      <div className="mt-4">
        {list.isLoading && (
          <div className="flex justify-center py-8">
            <div className="h-5 w-5 animate-spin rounded-full border-2 border-ink-200 border-t-ink-900" />
          </div>
        )}

        {list.isError && (
          <p className="py-4 text-center text-sm text-ink-400">Couldn't load favorites. Try reloading.</p>
        )}

        {list.data && list.data.count === 0 && (
          <p className="rounded-lg border border-dashed border-ink-200 py-6 text-center text-sm text-ink-400">
            No favorites yet — picks will show up here once your client starts favoriting photos.
          </p>
        )}

        {list.data && list.data.count > 0 && (
          <>
            <div className="max-h-40 overflow-y-auto rounded-lg border border-ink-100 bg-ink-50 p-3">
              <p className="break-words font-mono text-xs leading-relaxed text-ink-600">{list.data.text}</p>
            </div>
            <button
              onClick={() => handleCopy(list.data!.text)}
              className="mt-3 w-full rounded-lg bg-ink-900 px-4 py-2.5 text-sm font-medium text-white transition-colors hover:bg-ink-800"
            >
              {copied ? "Copied!" : "Copy Lightroom list"}
            </button>
          </>
        )}
      </div>
    </div>
  );
}
