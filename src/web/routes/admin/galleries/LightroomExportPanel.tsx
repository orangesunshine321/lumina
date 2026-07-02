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
    <div className="rounded-2xl border border-line bg-surface p-5">
      <div className="flex items-center justify-between gap-4">
        <div>
          <h3 className="text-sm font-semibold text-text-1">Lightroom picks</h3>
          <p className="mt-0.5 text-xs text-text-3">
            Paste into Lightroom Classic&apos;s Library Filter (Text → Filename → match Any) to
            select every pick at once.
          </p>
        </div>
        {list.data && list.data.count > 0 && (
          <span className="shrink-0 rounded-full bg-surface-2 px-2.5 py-1 text-xs font-medium text-text-1">
            {list.data.count} {list.data.count === 1 ? "favorite" : "favorites"}
          </span>
        )}
      </div>

      <div className="mt-4">
        {list.isLoading && (
          <div className="flex justify-center py-8">
            <div className="h-5 w-5 animate-spin rounded-full border-2 border-line-strong border-t-text-1" />
          </div>
        )}

        {list.isError && (
          <p className="py-4 text-center text-sm text-text-3">
            Couldn&apos;t load favorites. Try reloading.
          </p>
        )}

        {list.data && list.data.count === 0 && (
          <p className="rounded-lg border border-dashed border-line py-6 text-center text-sm text-text-3">
            No favorites yet — picks show up here once your client starts choosing.
          </p>
        )}

        {list.data && list.data.count > 0 && (
          <>
            <div className="max-h-40 overflow-y-auto rounded-lg border border-line bg-surface-2 p-3">
              <p className="break-words font-mono text-xs leading-relaxed text-text-2">
                {list.data.text}
              </p>
            </div>
            <button
              onClick={() => handleCopy(list.data!.text)}
              className="mt-3 w-full rounded-lg bg-text-1 px-4 py-2.5 text-sm font-medium text-invert transition-opacity hover:opacity-90"
            >
              {copied ? "Copied!" : "Copy Lightroom list"}
            </button>
          </>
        )}
      </div>
    </div>
  );
}
