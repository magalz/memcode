export function browserURL(value: string): URL {
  const text = value.trim();
  const url = new URL(
    /^[a-z][a-z\d+.-]*:\/\//i.test(text)
      ? text
      : /^(localhost|127\.0\.0\.1|\[::1\])(:|\/|$)/i.test(text)
        ? "http://" + text
        : "https://" + text,
  );
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (
    (url.protocol !== "https:" && !(url.protocol === "http:" && local)) ||
    !url.hostname ||
    url.username ||
    url.password ||
    ["tauri.localhost", "ipc.localhost", "asset.localhost"].includes(
      url.hostname,
    )
  )
    throw new Error("Open an HTTPS website or a localhost development server.");
  return url;
}
