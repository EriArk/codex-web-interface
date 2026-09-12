"""Deterministic Russian/Latin routing; no language service or external requests."""
import re

LETTERS = r"A-Za-zÀ-ÖØ-öø-ÿĀ-ſ"
TOKENS = re.compile(rf"[{LETTERS}]+(?:['’][{LETTERS}]+)*|[А-Яа-яЁё]+|[^{LETTERS}А-Яа-яЁё]+")


def language_parts(text, fallback="ru", limit=360):
    """Keep adjacent English words together and attach punctuation to its phrase.

    Numbers without letters keep the surrounding language. Splitting is lossless;
    very long input is bounded at sentence/word boundaries before either model.
    """
    runs = []
    prefix = ""
    for token in TOKENS.findall(text):
        language = ("ru" if re.match(r"[А-Яа-яЁё]", token) else
                    "en" if re.match(rf"[{LETTERS}]", token) else None)
        if language is None:
            if runs:
                runs[-1][1] += token
            else:
                prefix += token
        elif runs and runs[-1][0] == language:
            runs[-1][1] += token
        else:
            runs.append([language, prefix + token])
            prefix = ""
    if prefix:
        runs.append([fallback, prefix])
    for language, run in runs:
        while run:
            end = min(len(run), limit)
            if len(run) > limit:
                boundaries = list(re.finditer(r"[.!?;]\s+|\n+", run[:limit + 1]))
                if boundaries:
                    end = boundaries[-1].end()
                else:
                    space = run.rfind(" ", 0, limit + 1)
                    if space > 0:
                        end = space + 1
            yield language, run[:end]
            run = run[end:]


def spoken_english(text):
    # Source identifiers commonly occur in answers: WebKit, ChatGPT, iOS, TTS.
    text = re.sub(r"([a-z])([A-Z])", r"\1 \2", text)
    return re.sub(r"\b[A-Z]{2,6}\b", lambda match: " ".join(match[0]), text)
