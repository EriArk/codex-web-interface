import io
import unittest
import wave
from unittest.mock import patch
import numpy as np
import server
from text_parts import language_parts, spoken_english

class SpeechTests(unittest.TestCase):
    def test_mixed_spans_are_lossless_and_group_english_phrases(self):
        text = 'Проверь GitHub Actions и pull request, затем открой WebKit на iOS 18.'
        parts = list(language_parts(text))
        self.assertEqual(''.join(text for _, text in parts), text)
        self.assertEqual([s.strip() for lang, s in parts if lang == 'en'],
                         ['GitHub Actions', 'pull request,', 'WebKit', 'iOS 18.'])
        self.assertEqual(spoken_english('ChatGPT API, WebKit и iOS'), 'Chat G P T A P I, Web Kit и i O S')

    def test_languages_numbers_and_long_input(self):
        for text in ['123.45', '“Hello, world!”', 'Ёлки, ёжики.', '😀 Тест v2.3 и SQL.', 'Слово' * 500, 'word ' * 3000]:
            parts = list(language_parts(text))
            self.assertEqual(''.join(s for _, s in parts), text)
            self.assertTrue(all(0 < len(s) <= 361 for _, s in parts))
        self.assertEqual(list(language_parts('Hello world', 'ru')), [('en', 'Hello world')])
        self.assertEqual(list(language_parts('По-русски', 'en')), [('ru', 'По-русски')])

    def test_join_routes_every_voice_and_writes_single_consistent_wave(self):
        calls = []
        def samples(text, language, voice):
            calls.append((language, voice))
            rate = 22050 if language == 'en' else 24000
            return (np.sin(np.arange(rate // 4) * 2 * np.pi * 440 / rate) * 0.2).astype(np.float32), rate
        with patch.object(server, 'samples_for', samples):
            for voice in server.VOICE_IDS:
                audio = server.synthesize('Проверка English words завершена.', 'ru', voice=voice)
                with wave.open(io.BytesIO(audio)) as track:
                    self.assertEqual((track.getnchannels(), track.getsampwidth(), track.getframerate()), (1, 2, 24000))
                    self.assertGreater(track.getnframes(), 24000 * .7)
                    self.assertLess(track.getnframes(), 24000 * 1.1)
                self.assertEqual(calls[-3:], [('ru', voice), ('en', voice), ('ru', voice)])

    def test_resampling_preserves_tone_and_controls_peaks(self):
        rate = 22050
        signal = np.sin(np.arange(rate) * 2 * np.pi * 440 / rate).astype(np.float32)
        converted = server.prepare_samples(signal, rate)
        peak = np.argmax(np.abs(np.fft.rfft(converted))) * 24000 / len(converted)
        self.assertAlmostEqual(peak, 440, delta=2)
        self.assertLessEqual(np.max(np.abs(converted)), .941)
        self.assertEqual(converted[0], 0)
        self.assertEqual(converted[-1], 0)

    def test_cancel_and_limits_do_not_synthesize_more_parts(self):
        with patch.object(server, 'samples_for') as synth:
            with self.assertRaises(ConnectionResetError):
                server.synthesize('Привет', 'ru', cancelled=lambda: True)
            synth.assert_not_called()
        with self.assertRaises(ValueError):
            server.synthesize('Текст', 'ru', voice='../untrusted')
        with patch.object(server, 'samples_for', return_value=(np.ones(1000, dtype=np.float32), 24000)), patch.object(server, 'MAX_AUDIO', 100):
            with self.assertRaises(ValueError): server.synthesize('Текст', 'ru')

if __name__ == '__main__':
    unittest.main()
