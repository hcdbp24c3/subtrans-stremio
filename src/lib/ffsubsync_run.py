#!/usr/bin/env python3
"""ffsubsync library bridge — returns JSON offset/score, no CLI log parsing.

Usage:
  ffsubsync_run.py sub-to-sub <ref.srt> <target.srt>
  ffsubsync_run.py video <url> <target.srt> [--fast]

Modes:
  sub-to-sub  Sync target against a local reference SRT (fastest; ~1s).
  video       Sync target against remote/local video using ffsubsync library.
              --fast uses extract-audio-first + max-duration 60 + ref-stream a:0
              (skips the slow "Checking video for subtitles stream" probe on
              large remote REMUXes; copies only first 60s of audio).
"""
from __future__ import annotations

import io
import json
import logging
import re
import sys
import tempfile
import os


def _capture_logs():
    buf = io.StringIO()
    handler = logging.StreamHandler(buf)
    handler.setFormatter(logging.Formatter("%(message)s"))
    root = logging.getLogger()
    root.setLevel(logging.INFO)
    root.addHandler(handler)
    return buf, handler


def _parse_score(log_text: str) -> float:
    m = re.search(r"score:\s*([-\d.]+)", log_text)
    return float(m.group(1)) if m else 0.0


def _run(args_list: list[str]) -> dict:
    from ffsubsync.ffsubsync import run, make_parser

    buf, handler = _capture_logs()
    try:
        args = make_parser().parse_args(args_list)
        result = run(args)
    finally:
        logging.getLogger().removeHandler(handler)
    log_text = buf.getvalue()
    score = _parse_score(log_text)
    offset = result.get("offset_seconds")
    retval = result.get("retval")
    if retval is None:
        retval = 1
    ok = bool(result.get("sync_was_successful")) and int(retval) == 0
    if offset is None:
        offset = 0.0
    return {
        "offset": float(offset),
        "score": score,
        "ok": ok and score > 0,
        "retval": int(retval),
    }


def main() -> int:
    if len(sys.argv) < 2:
        print(json.dumps({"offset": 0, "score": 0, "ok": False, "error": "usage"}))
        return 2
    mode = sys.argv[1]
    try:
        if mode == "sub-to-sub":
            if len(sys.argv) < 4:
                raise ValueError("sub-to-sub needs ref.srt target.srt")
            ref, target = sys.argv[2], sys.argv[3]
            out = tempfile.NamedTemporaryFile(suffix=".srt", delete=False)
            out.close()
            try:
                payload = _run(
                    [ref, "-i", target, "-o", out.name, "--no-fix-framerate"]
                )
            finally:
                try:
                    os.unlink(out.name)
                except OSError:
                    pass
        elif mode == "video":
            if len(sys.argv) < 4:
                raise ValueError("video needs url target.srt")
            url, target = sys.argv[2], sys.argv[3]
            fast = "--fast" in sys.argv[4:]
            out = tempfile.NamedTemporaryFile(suffix=".srt", delete=False)
            out.close()
            argv = [url, "-i", target, "-o", out.name, "--no-fix-framerate"]
            if fast:
                # Skip embedded-sub probe (hangs on 62GB remote); bound audio copy.
                argv += [
                    "--extract-audio-first",
                    "--max-duration-seconds",
                    "60",
                    "--reference-stream",
                    "a:0",
                ]
            try:
                payload = _run(argv)
            finally:
                try:
                    os.unlink(out.name)
                except OSError:
                    pass
        else:
            raise ValueError(f"unknown mode {mode!r}")
        print(json.dumps(payload))
        return 0 if payload.get("ok") else 1
    except Exception as e:  # noqa: BLE001 — surface as JSON for Node
        print(
            json.dumps(
                {"offset": 0, "score": 0, "ok": False, "error": str(e)[:300]}
            )
        )
        return 1


if __name__ == "__main__":
    sys.exit(main())
