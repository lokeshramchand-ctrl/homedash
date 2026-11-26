# Submitting to community-scripts

Status: **not submitted.** This page says what the collection asks for and where this repository stands, so the step can be taken deliberately.

## Where a new script goes

According to the community-scripts contribution guide, pull requests that add a *new* script directly to `ProxmoxVE` are closed without review. New scripts go to the testing repository **`ProxmoxVED`** first, and maintainers promote them once they have been verified there. Read the current guide before opening anything, because the process changes: <https://community-scripts.org/docs/contribution>.

A script is three files, all present here:

| File | In this repo | In their repo |
|---|---|---|
| Container script | `ct/homedash.sh` | `ct/homedash.sh` |
| Install script | `install/homedash-install.sh` | `install/homedash-install.sh` |
| Metadata | `json/homedash.json` | `frontend/public/json/homedash.json` |

## Checklist

| Item | State |
|---|---|
| Container script has an `update_script` function | Done (`ct/homedash.sh`) |
| Resource defaults declared (`var_cpu`, `var_ram`, `var_disk`, `var_os`, `var_version`, `var_unprivileged`) | Done: 1 CPU, 1024 MB, 6 GB, Debian 13, unprivileged |
| Shellcheck clean, `bash -n` clean | Done, enforced in CI (`.shellcheckrc` silences only the warnings caused by variables the framework defines) |
| No hard-coded credentials; admin password generated and shown once | Done |
| Metadata describes the app accurately | Done (stale "single-user" wording removed) |
| Documentation link, website, logo URL | Present; the logo URL points at this repository |
| **Tested in a real container on a real Proxmox host** | **Not done.** `tools/dev/test-ct.sh` creates a throwaway container, runs the real installer in it and removes it. Run it on your host before submitting: `bash tools/dev/test-ct.sh --keep 9999 <ip>/24 <gateway> <bridge>` |
| Tested update path (`update` inside a container installed by an earlier version) | **Not done** |
| Maintainers' own current template followed line by line | **Not done.** The scripts were written against the framework helpers (`build.func`, `install.func`); compare with the template in their `docs/contribution` folder when you submit |

## Before you submit

1. Run `tools/dev/test-ct.sh` on your Proxmox host and fix whatever it finds.
2. Install once from the README command, then run `update` in the container.
3. Fork ProxmoxVED, copy the three files to the paths above, open the pull request there, and follow the template the maintainers give.
4. Until it is accepted, the README command runs the script from this repository, which already works.
