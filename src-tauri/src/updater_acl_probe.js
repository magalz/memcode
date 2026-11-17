// Fixed acceptance program, injected only for an explicitly isolated native QA run.
// Every mutating updater call must stop at the existing development guard.
(() => {
  if (window.top !== window || window.__memcodeUpdaterAclProbe) return;
  window.__memcodeUpdaterAclProbe = true;
  const guarded = "Development builds update through Git. Install a beta release to use signed app updates.";
  let attempts = 0;
  const start = async () => {
    const native = window.__TAURI_INTERNALS__;
    if (!native?.invoke || !native?.transformCallback) {
      if (++attempts < 100) setTimeout(start, 100);
      return;
    }
    const mark = async (stage) => {
      // The existing transport trace records only this fixed, content-free method.
      // No new native reporting command or renderer capability is introduced.
      await native.invoke("rpc", { method: "updater-acl:" + stage, input: null }).catch(() => {});
    };
    try {
      const info = await native.invoke("app_update_info");
      if (info.development !== true || !/^\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?$/.test(info.currentVersion)) {
        await mark("info:unexpected");
        return;
      }
      await mark("version:" + info.currentVersion);
      await mark("info:pass");
    } catch (error) {
      await mark(/not allowed|ACL|permission denied/i.test(String(error)) ? "info:acl-denied" : "info:unexpected-error");
      return;
    }
    const id = native.transformCallback(() => {});
    const channel = "__CHANNEL__:" + id;
    for (const [name, command, input] of [
      ["check", "app_update_check", {}],
      ["download", "app_update_download", { version: "0.0.0", channel }],
      ["install", "app_update_install", { version: "0.0.0", channel }],
    ]) {
      try {
        await native.invoke(command, input);
        await mark(name + ":unexpected-success");
      } catch (error) {
        const message = String(error);
        await mark(name + (message === guarded ? ":pass" : /not allowed|ACL|permission denied/i.test(message) ? ":acl-denied" : ":unexpected-error"));
      }
    }
    await mark("finished");
  };
  void start();
})();
