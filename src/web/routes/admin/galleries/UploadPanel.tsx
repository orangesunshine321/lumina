import { useEffect, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import Uppy from "@uppy/core";
import XHRUpload from "@uppy/xhr-upload";
import Dashboard from "@uppy/react/dashboard";
import "@uppy/react/css/style.css";
import { api } from "../../../lib/api.ts";

export function UploadPanel({ galleryId }: { galleryId: string }) {
  const queryClient = useQueryClient();

  const [uppy] = useState(() => {
    const instance = new Uppy({
      restrictions: { allowedFileTypes: [".jpg", ".jpeg", "image/jpeg"] },
      autoProceed: true,
    }).use(XHRUpload, {
      endpoint: `/api/admin/galleries/${galleryId}/uploads`,
      fieldName: "file",
      bundle: false,
      limit: 5,
      withCredentials: true,
    });

    instance.on("files-added", async (files) => {
      if (!files.length) return;
      try {
        const { existing } = await api.post<{ existing: string[] }>(
          `/api/admin/galleries/${galleryId}/uploads/check`,
          { files: files.map((f) => ({ filename: f.name, size: f.size ?? 0 })) },
        );
        const existingSet = new Set(existing);
        for (const file of files) {
          if (existingSet.has(file.name)) {
            instance.removeFile(file.id);
          }
        }
      } catch {
        // Dedup check is best-effort — if it fails, just let the upload proceed normally.
      }
    });

    instance.on("upload-success", () => {
      queryClient.invalidateQueries({ queryKey: ["admin-gallery-photos", galleryId] });
    });

    return instance;
  });

  useEffect(() => {
    return () => {
      uppy.destroy();
    };
  }, [uppy]);

  return (
    <div className="overflow-hidden rounded-2xl border border-ink-100 bg-white shadow-sm">
      <Dashboard uppy={uppy} proudlyDisplayPoweredByUppy={false} height={320} />
    </div>
  );
}
