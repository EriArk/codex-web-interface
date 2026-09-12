# Private background read-aloud

The optional `speech` Compose profile renders public message prose into one WAV track. The browser plays that track through HTMLAudioElement and registers Media Session play/pause/stop/seek actions. `navigator.audioSession.type = playback` is feature-detected and restored after playback. No audio is segmented into JavaScript-triggered tracks, and hiding the document does not stop playback. Navigation to another conversation, explicit Stop, page teardown and logout still cancel it. Actual iPhone lock-screen behavior must be verified on the owner's device; browser emulation cannot establish that.

Piper and Silero run on the Linux Hub in a separate CPU/memory-limited (one CPU, 2 GiB), read-only container with **no network**. Only a mode-0600 Unix socket in a private directory connects it to the authenticated Hub. It does not use an OpenAI API key, hosted voice service, microphone or the Windows PC. This is an independent synthetic voice, not the ChatGPT Voice service or the iPhone system voice.

Settings → Sound and notifications → Background audio offers Eugene / Kseniya (Silero v5.5 Russian) and Ruslan (Piper), shared by Codex/GPT and remembered on the device. Eugene is the initial server voice. System voice remains a separate mode, without speech-worker requests. Changing voice stops the current clip; it does not replay the message automatically.

The books narrator's tuning is retained: Silero auto-stress/ё and slow prosody; Piper length_scale 1.16, noise_scale .45, noise_w_scale .55. Playback is 0.85× for every server voice, including English, with pitch preservation, matching the books player's default. These are two separate layers (narration prosody and player speed), not an assertion that different speakers have identical words per minute.

Russian and Latin spans route to their respective models; consecutive English words stay together. English uses the existing LJ Speech Piper model. Short capitalized acronyms and camel-case identifiers are prepared for English pronunciation. This is script-based routing for Russian/English, not general multilingual language detection. All PCM is resampled to mono 24 kHz with libsoxr, gently level-matched and joined with bounded punctuation-aware pauses and short click-suppressing fades. No new browser track is needed at a language boundary. Foreign words written in Cyrillic still go to the Russian voice; switching languages also changes the speaker's timbre.

## Setup

1. Create `$CODEX_WEB_STATE/speech` owned by the Hub UID (1000), mode 0700.
2. Build `ops/speech/Dockerfile` and start the Compose `speech` service with `SPEECH_REVISION` set to the built tag.
3. Configure `hub.speechSocket` as `/run/codex-speech/speech.sock` and deploy the Hub with the matching read-only socket-directory mount.

Builds pin Python/Piper dependencies and CPU PyTorch 2.14.0. Piper model files and the Silero package are checked against pinned byte counts and SHA-256 before model loading. Model cards, the publisher license and download manifests remain in the image. Build-time synthesis checks all three voices and mixed text. Health checks and synthesis use the Unix socket; no host or container TCP port is opened.

The worker accepts legacy `{text, language}` requests and the additive `voice` field. `/health` advertises only supported voice IDs. The Hub exposes this allowlisted capability through `/api/speech/status`; the new UI never sends a voice field to an older Hub. An explicit unsupported voice fails instead of being silently replaced. The selected voice participates in each session-owned clip's idempotency fingerprint. No database migration is needed for this feature. Worker-only updates can improve mixed speech for old clients; exposing the chooser needs the matching engine API and web assets, and engine replacement still follows guarded idle maintenance.

Worker checks: `python test_speech.py` inside the built image; Hub/media checks: `tests/background-speech.test.mjs`, `tests/message-speech.test.mjs`, and `tests/background-media.browser.mjs` in Chromium/WebKit. Exercise all voices with real synthesis in the isolated image before deployment; playback emulation is not physical iOS acceptance.

The Hub enforces its existing password-only session and CSRF boundary. Each ephemeral clip belongs to the creating session and requires that session on every media/range request. It rechecks login after synthesis. Limits: 30,000 characters, one render at a time, 150-second worker synthesis / 180-second Hub deadline, 64 MiB per clip, three cached clips and a 30-minute idle lifetime. Text/audio is not logged or persisted. Stop aborts rendering and removes the clip; interrupted HTTP streams and invalid WAVs fail closed. Byte ranges support Safari seek/reconnect without regenerating speech. Browser registration and playback begin within the original tap; the media endpoint briefly waits for the matching CSRF-protected registration.

Without a configured/healthy worker, or for unusually long answers, the existing local system voice remains available. Its background behavior depends on the browser/OS. No external voice fallback is used.

## Sources and attribution

- Piper 1.8.0: [OHF-Voice/piper1-gpl](https://github.com/OHF-Voice/piper1-gpl), GPL-3.0. Piper and its dependencies retain their package license notices in the image. Redistributors must follow those licenses.
- Voices: [rhasspy/piper-voices](https://huggingface.co/rhasspy/piper-voices), revision `1162a9173d0ce503555aed757976b7a9912eae4c`; exact downloaded assets are listed in `voices.json`.
- Russian `ru_RU-ruslan-medium`: Ruslan corpus, [dataset authors/source](https://ruslan-corpus.github.io/), [CC BY-NC-SA 4.0](https://creativecommons.org/licenses/by-nc-sa/4.0/), as declared in the bundled model card. The default deployment is the owner's private, noncommercial use. This voice must not be presented as unrestricted for commercial redistribution; choose appropriately licensed voices for that purpose.
- English `en_US-ljspeech-medium`: LJ Speech dataset, public domain according to its bundled model card; training attribution is retained there.
- Silero Russian v5_5_ru: [snakers4/silero-models](https://github.com/snakers4/silero-models), Eugene and Kseniya, the same 145,420,684-byte package used by books. SHA-256 `50081637b602126ee06cb3bc8a744d25651d2da149ee8864b9a379bfdd934437`. Publisher license is pinned and retained by `download_silero.py`; this full Russian model is for noncommercial use under its publisher terms, consistent with the owner's private installation.
- Resampling: [python-soxr](https://github.com/dofuuz/python-soxr), CPU libsoxr high-quality rate conversion; no speech or text leaves the container.
