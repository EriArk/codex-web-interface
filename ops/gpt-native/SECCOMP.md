# Native client sandbox

`seccomp.json` is based on the profile from Microsoft Playwright v1.62.0:
https://github.com/microsoft/playwright/blob/v1.62.0/utils/docker/seccomp_profile.json
(Apache-2.0; matches the pinned base image).

The only additional syscall is `chroot`, needed inside Chromium's new user namespace; no container capability is granted.

It keeps a syscall allowlist and permits the unprivileged namespace operations
needed by Chromium. Run the native image as UID 1000 with all capabilities
dropped, no-new-privileges and this profile. Do not use privileged mode,
seccomp=unconfined or --no-sandbox. The default Docker profile on this host blocks
the application's user namespace sandbox. Do not disable it globally.

Verify renderer processes have distinct user/PID/network namespaces and an
additional seccomp filter before owner admission. The inherited debugging pipe
belongs only to the private supervisor; never publish a debugger port.
