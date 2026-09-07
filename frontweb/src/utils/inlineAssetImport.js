export function isBrowserUploadFile(value) {
  return typeof Blob !== 'undefined' && value instanceof Blob
}

export function pendingUploadItems(items = []) {
  return (Array.isArray(items) ? items : []).filter((item) => (
    item?.restored !== true
    && !item?.source_token
    && isBrowserUploadFile(item?.file)
    && Number(item.file.size) > 0
  ))
}

export function restoredRelativePaths(items = []) {
  return [...new Set((Array.isArray(items) ? items : [])
    .filter((item) => item?.restored === true && item?.relative_path)
    .map((item) => String(item.relative_path)))]
}

export function freshScanDescriptors(items = []) {
  return (Array.isArray(items) ? items : [])
    .filter((item) => item?.restored !== true && item?.source_token)
    .map((item) => ({
      relative_path: item.relative_path,
      file_name: item.file?.name || item.relative_path,
      source_token: item.source_token,
      bytes: Number(item.file?.size) || 0,
      mime_type: item.file?.type || '',
    }))
}
