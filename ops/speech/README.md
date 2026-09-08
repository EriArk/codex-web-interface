# Private background read-aloud

The optional `speech` Compose profile renders public message prose into one WAV track. The browser plays that track through HTMLAudioElement and registers Media Session play/pause/stop/seek actions. `navigator.audioSession.type = playback` is feature-detected and restored after playback. No audio is segmented into JavaScript-triggered tracks, and hiding the document does not stop playback. Navigation to another conversation, explicit Stop, page teardown and logout still cancel it. Actual iPhone lock-screen behavior must be verified on the owner's device; browser emulation cannot establish that.

Piper runs on the Linux Hub in a separate CPU/memory-limited, read-only container with **no network**. Only a mode-0600 Unix socket in a private directory connects it to the authenticated Hub. It does not use an OpenAI API key, hosted voice service, microphone or the Windows PC. This is an independent synthetic voice, not the ChatGPT Voice service or the iPhone system voice.

## Setup

1. Create `$CODEX_WEB_STATE/speech` owned by the Hub UID (1000), mode 0700.
2. Build `ops/speech/Dockerfile` and start the Compose `speech` service with `SPEECH_REVISION` set to the built tag.
3. Configure `hub.speechSocket` as `/run/codex-speech/speech.sock` and deploy the Hub with the matching read-only socket-directory mount.

Builds pin Python, Python packages and the two voice files by revision, byte count and SHA-256. Model cards and a download manifest remain in the image. Build-time synthesis checks both languages. Health checks and synthesis use the Unix socket; no host or container TCP port is opened.

The Hub enforces its existing password-only session and CSRF boundary. Each ephemeral clip belongs to the creating session and requires that session on every media/range request. It rechecks login after synthesis. Limits: 30,000 characters, one render at a time, 150-second worker synthesis / 180-second Hub deadline, 64 MiB per clip, three cached clips and a 30-minute idle lifetime. Text/audio is not logged or persisted. Stop aborts rendering and removes the clip; interrupted HTTP streams and invalid WAVs fail closed. Byte ranges support Safari seek/reconnect without regenerating speech. Browser registration and playback begin within the original tap; the media endpoint briefly waits for the matching CSRF-protected registration.

Without a configured/healthy worker, or for unusually long answers, the existing local system voice remains available. Its background behavior depends on the browser/OS. No external voice fallback is used.

## Sources and attribution

- Piper 1.8.0: [OHF-Voice/piper1-gpl](https://github.com/OHF-Voice/piper1-gpl), GPL-3.0. Piper and its dependencies retain their package license notices in the image. Redistributors must follow those licenses.
- Voices: [rhasspy/piper-voices](https://huggingface.co/rhasspy/piper-voices), revision `1162a9173d0ce503555aed757976b7a9912eae4c`; exact downloaded assets are listed in `voices.json`.
- Russian `ru_RU-ruslan-medium`: Ruslan corpus, [dataset authors/source](https://ruslan-corpus.github.io/), [CC BY-NC-SA 4.0](https://creativecommons.org/licenses/by-nc-sa/4.0/), as declared in the bundled model card. The default deployment is the owner's private, noncommercial use. This voice must not be presented as unrestricted for commercial redistribution; choose appropriately licensed voices for that purpose.
- English `en_US-ljspeech-medium`: LJ Speech dataset, public domain according to its bundled model card; training attribution is retained there.
