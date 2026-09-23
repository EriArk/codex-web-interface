import { useEffect, useState } from "react";
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
            <a className="secondary" href={url} download={file.name}>
              Скачать черновик
            </a>
          )}
        </>
      }
    >
      <FilePreview file={file} objectUrl={url} full />
    </FileViewerDialog>
  );
}
