export function videoTaskErrorMessage(error?: string) {
  const message = error?.trim() || "";
  if (!message || /^(?:video_)?task_[a-z\d_-]+$/i.test(message)) {
    return "上游未提供具体失败原因，请稍后重试。";
  }
  if (/^(?:task failed|video generation failed|the video generation task failed)[.!]?$/i.test(message)) {
    return "上游视频生成失败，未提供具体原因。请稍后重试。";
  }
  return message;
}
