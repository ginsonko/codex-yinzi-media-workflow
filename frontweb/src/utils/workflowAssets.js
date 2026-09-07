export function hasStoryboardVisual(board) {
  return Boolean(board?.director_frame_path || board?.local_path || board?.image_url)
}
