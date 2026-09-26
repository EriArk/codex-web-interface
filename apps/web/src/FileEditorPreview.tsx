import { useEffect, useState } from "react";
import { DownloadLink } from "./DownloadLink";
import { FilePreview } from "./FilePreview";
import { FileViewerDialog } from "./FileViewerDialog";

/** A frozen draft snapshot; previewing never invokes a file write. */
export function FileEditorPreview({ file, onClose }: { file: File; onClose: () => void }) {
  const [url, setUrl] = useState("");
  useEffect(() => {
    // Downloads retain bytes, but executable source never gets a same-origin document URL.
    const value = URL.createObjectURL(new Blob([file], { type: "application/octet-stream" }));
    setUrl(value);
    return () => URL.revokeObjectURL(value);
  }, [file]);
  return (
    <FileViewerDialog
      name={file.name}
      file={file}
      draft
      onClose={onClose}
      actions={
        <>
          <button type="button" className="secondary" onClick={onClose}>
            К редактору
          </button>
          {url && (
            <DownloadLink preparedFile={file} directDownload>
              Скачать черновик
            </DownloadLink>
          )}
        </>
      }
    >
      <FilePreview file={file} objectUrl={url} full />
    </FileViewerDialog>
  );
}
