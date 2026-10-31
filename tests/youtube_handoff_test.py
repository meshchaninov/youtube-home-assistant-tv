"""Run with Python containing requests/casttube, or inside the HA container."""
import importlib.util
from pathlib import Path
import sys
import time
import unittest
from unittest.mock import Mock, patch

source = Path(sys.argv.pop(1)) if len(sys.argv) > 1 else Path(__file__).resolve().parents[1] / 'home-assistant/youtube_handoff.py'
spec = importlib.util.spec_from_file_location('handoff', source)
handoff = importlib.util.module_from_spec(spec)
spec.loader.exec_module(handoff)


class HandoffTests(unittest.TestCase):
    def test_invalid_values_cannot_reach_network(self):
        with patch.object(handoff.requests, 'get') as get:
            for video, position in [('bad;echo', 1), ('aqz-KE-bpKQ', -1), ('aqz-KE-bpKQ', 'nan'), ('aqz-KE-bpKQ', 'inf')]:
                with self.assertRaises(ValueError):
                    handoff.play(video, position)
            get.assert_not_called()

    def test_passes_start_time_to_native_youtube_protocol(self):
        response = Mock(content=b'<service xmlns="urn:dial"><additionalData><screenId>test-screen</screenId></additionalData></service>')
        with patch.object(handoff.requests, 'get', return_value=response), patch.object(handoff.BoundedYouTubeSession, 'play_video') as play, patch.object(handoff.BoundedYouTubeSession, 'synchronize_position') as sync, patch.object(handoff.time, 'sleep'):
            result = handoff.play('aqz-KE-bpKQ', 210.9)
            play.assert_called_once_with('aqz-KE-bpKQ', start_time='210')
            sync.assert_called_once_with(210)
            self.assertTrue(result['ok'])

    def test_zero_is_not_dropped_when_the_same_video_is_sent_again(self):
        response = Mock(content=b'<service><screenId>test-screen</screenId></service>')
        with patch.object(handoff.requests, 'get', return_value=response), patch.object(handoff.BoundedYouTubeSession, 'play_video') as play, patch.object(handoff.BoundedYouTubeSession, 'synchronize_position') as sync, patch.object(handoff.time, 'sleep'):
            handoff.play('aqz-KE-bpKQ', 90)
            handoff.play('aqz-KE-bpKQ', 0)
            self.assertEqual(play.call_args.kwargs['start_time'], '0')
            self.assertEqual([call.args[0] for call in sync.call_args_list], [90, 0])

    def test_explicit_seek_to_zero_precedes_play_and_uses_existing_session(self):
        session = handoff.BoundedYouTubeSession('screen', time.monotonic() + 45)
        session._sid = 'test-sid'
        session._gsession_id = 'test-session'
        session._lounge_token = 'test-token'
        with patch.object(session, '_do_post') as post:
            session.synchronize_position(0)
        seek, play = post.call_args_list
        self.assertEqual(seek.kwargs['data']['req0__sc'], 'seekTo')
        self.assertEqual(seek.kwargs['data']['req0_newTime'], '0')
        self.assertEqual(play.kwargs['data']['req0__sc'], 'play')
        self.assertTrue(seek.kwargs['session_request'])
        self.assertEqual(seek.kwargs['params']['SID'], 'test-sid')

    def test_retries_session_setup_after_transient_timeout(self):
        session = handoff.BoundedYouTubeSession('screen', time.monotonic() + 45)
        response = Mock(status_code=200)
        session.http.post = Mock(side_effect=[handoff.requests.ReadTimeout(), response])
        self.assertIs(session._do_post('https://www.youtube.com/api/lounge/pairing/get_lounge_token_batch'), response)
        self.assertEqual(session.http.post.call_count, 2)

    def test_never_repeats_play_request_after_ambiguous_timeout(self):
        session = handoff.BoundedYouTubeSession('screen', time.monotonic() + 45)
        session.http.post = Mock(side_effect=handoff.requests.ReadTimeout())
        with self.assertRaises(handoff.requests.ReadTimeout):
            session._do_post('https://www.youtube.com/api/lounge/bc/bind', session_request=True)
        self.assertEqual(session.http.post.call_count, 1)


if __name__ == '__main__':
    unittest.main()
