#!/usr/bin/env python3
"""
[AI_CONTEXT]
purpose: Enter a Linux child-subreaper boundary before starting one local review worker supervisor.
touches: Linux prctl process ownership and the worker supervisor launch.
invariants: orphaned worker descendants reparent to the exact per-invocation supervisor.
inputs: an absolute Node executable, the supervisor module, and its JSON config.
outputs: the supervisor process with the original boundary PID.
see: worker-supervisor.mjs
"""

from __future__ import annotations

import ctypes
import os
import sys


PR_SET_CHILD_SUBREAPER = 36
BOUNDARY_ENV_NAME = "PR_REVIEW_FOLLOWUP_SUBREAPER"


def main() -> None:
    if sys.platform != "linux":
        raise RuntimeError("worker supervision requires Linux process metadata")
    if len(sys.argv) < 4:
        raise RuntimeError(
            "worker boundary requires the Node executable, supervisor module, and config"
        )

    libc = ctypes.CDLL(None, use_errno=True)
    result = libc.prctl(
        ctypes.c_int(PR_SET_CHILD_SUBREAPER),
        ctypes.c_ulong(1),
        ctypes.c_ulong(0),
        ctypes.c_ulong(0),
        ctypes.c_ulong(0),
    )
    if result != 0:
        error_number = ctypes.get_errno()
        raise OSError(error_number, os.strerror(error_number))

    os.environ[BOUNDARY_ENV_NAME] = "1"
    executable = sys.argv[1]
    os.execv(executable, [executable, *sys.argv[2:]])


if __name__ == "__main__":
    main()
