"""Runs inside Home Assistant. No browser/HA credentials required."""
import json
import math
import re
import sys
import time
import xml.etree.ElementTree as ET

import requests
from casttube import YouTubeSession
from casttube.YouTubeSession import BIND_URL, HEADERS, LOUNGE_ID_HEADER

TV_HOST = "192.0.2.10"


class BoundedYouTubeSession(YouTubeSession):
    def __init__(self, screen_id, deadline):
        super().__init__(screen_id)
        self.deadline = deadline
        self.http = requests.Session()

    def _do_post(self, url, data=None, params=None, headers=None, session_request=False):
        # Session setup is safe to retry. Never replay the final play command.
        for attempt in range(1 if session_request else 2):
            remaining = self.deadline - time.monotonic()
            if remaining <= 0:
                raise TimeoutError("YouTube did not respond in time")
            try:
                response = self.http.post(
                    url, data=data, params=params, headers={**HEADERS, **(headers or {})},
                    timeout=(min(6, remaining), min(12, remaining)),
                )
                break
            except (requests.Timeout, requests.ConnectionError):
                if session_request or attempt == 1:
                    raise
        # Fail explicitly instead of allowing casttube's recursive session recovery.
        response.raise_for_status()
        if session_request:
            self._req_count += 1
        self._rid += 1
        return response


    def synchronize_position(self, position):
        """Force an absolute position, including zero, in the existing TV session."""
        if not self._sid or not self._gsession_id or not self._lounge_token:
            raise RuntimeError("YouTube session is not connected")
        # setPlaylist's start_time can be ignored when the same video is already
        # playing. Use an explicit seek in the same session, then resume playback.
        for command, arguments in [('seekTo', {'_newTime': str(position)}), ('play', {})]:
            self._do_post(
                BIND_URL,
                data=self._format_session_params({'__sc': command, 'count': 1, **arguments}),
                params={'SID': self._sid, 'gsessionid': self._gsession_id,
                        'RID': self._rid, 'VER': 8, 'CVER': 1},
                headers={LOUNGE_ID_HEADER: self._lounge_token},
                session_request=True,
            )


def play(video_id, position):
    if not re.fullmatch(r"[A-Za-z0-9_-]{11}", video_id):
        raise ValueError("Invalid YouTube video ID")
    position = float(position)
    if not math.isfinite(position) or not 0 <= position <= 604800:
        raise ValueError("Invalid playback position")
    position = int(position)
    deadline = time.monotonic() + 45
    screen_id = None
    # HA has already powered on the TV and selected YouTube; wait for DIAL readiness.
    for _ in range(10):
        try:
            response = requests.get(f"http://{TV_HOST}:8080/ws/app/YouTube", timeout=2)
            response.raise_for_status()
            root = ET.fromstring(response.content)
            screen_id = next((e.text for e in root.iter() if e.tag.split('}')[-1] == 'screenId' and e.text), None)
            if screen_id:
                break
        except (requests.RequestException, ET.ParseError):
            pass
        if time.monotonic() > deadline - 20:
            break
        time.sleep(1)
    if not screen_id:
        raise RuntimeError("YouTube DIAL screenId unavailable; open YouTube on the TV and try again")
    session = BoundedYouTubeSession(screen_id, deadline)
    session.play_video(video_id, start_time=str(position))
    # Allow the TV to process the selected video before the explicit seek.
    time.sleep(1)
    session.synchronize_position(position)
    # This confirms an accepted Lounge request, not physical video playback.
    return {"ok": True, "video_id": video_id, "position": position, "status": "command_sent"}


if __name__ == "__main__":
    try:
        if len(sys.argv) != 3:
            raise ValueError("Expected video_id and position")
        print(json.dumps(play(sys.argv[1], sys.argv[2])))
    except Exception as error:
        # Avoid URLs, screen IDs, Lounge tokens or request bodies in HA traces.
        print(json.dumps({"ok": False, "error": type(error).__name__}), file=sys.stderr)
        sys.exit(1)
